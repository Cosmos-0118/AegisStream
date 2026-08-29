/**
 * Regression: the manifest-refresh retry budget must be spent per attempt, not
 * per reporting frame.
 *
 * Field failure: content scripts are injected with all_frames:true and the
 * refresh is broadcast via chrome.tabs.sendMessage with no frameId, so every
 * frame fetches the playlist and every frame reports its own failure for the
 * SAME generation. Each report was charged as a retry, so on a 4-frame embed
 * page MANIFEST_REFRESH_MAX_RETRIES=5 collapsed into 2 real network rounds
 * inside 8 seconds — none of the intended backoff — and the tab dropped into
 * auth_expired. isPrefetchBlocked() then hard-stops prefetch, and because
 * auth_expired had no timer-driven exit the tab stayed dead for the rest of the
 * session (observed: 14m48s of a 17.5-minute session, zero prefetch).
 *
 * Contract:
 *  1. N frames reporting failure for one generation cost exactly ONE retry.
 *  2. A new generation is chargeable again.
 *  3. The budget is still finite: maxRetries+1 real rounds -> auth_expired.
 *  4. Entering auth_expired schedules a bounded self-heal.
 *
 * Run: node test/background/prefetch/playlist/manifest-refresh-retry-budget.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const modulePath = path.join(
  __dirname,
  "../../../../src/background/prefetch/playlist/manifest-refresh.js"
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const REFRESHING = "refreshing"
const AUTH_EXPIRED = "auth_expired"
const HEALTHY = "healthy"

function makeHarness({ maxRetries = 5, selfHealAttempts = 4 } = {}) {
  const timers = []
  const logs = []
  const tabState = {
    refreshState: REFRESHING,
    refreshRetryAttempt: 0,
    pendingManifestGeneration: 1,
    mediaPlaylistUrl: "https://cdn.example.com/v/index.m3u8"
  }
  const sandbox = {
    self: {
      AegisBackground: {
        constants: {
          MANIFEST_REFRESH_MAX_RETRIES: maxRetries,
          AUTH_EXPIRED_RETRY_COOLDOWN_MS: 30_000,
          AUTH_EXPIRED_SELF_HEAL_MAX_ATTEMPTS: selfHealAttempts,
          PREFETCH_PAUSE_AFTER_REFRESH_MS: 1000,
          REFRESH_RECOVERY_MAX_MS: 5000,
          MANIFEST_REFRESH_DEBOUNCE_MS: 1000
        },
        state: { playlistByTab: new Map([[1, tabState]]) },
        addLog: (level, msg) => logs.push(`${level}:${msg}`),
        REFRESH_STATE_HEALTHY: HEALTHY,
        REFRESH_STATE_REFRESHING: REFRESHING,
        REFRESH_STATE_AUTH_EXPIRED: AUTH_EXPIRED,
        REFRESH_STATE_RECOVERING: "recovering",
        PLAYLIST_CAPTURE_STATE: { HEALTHY: "healthy", REFRESHING: "refreshing", RECOVERING: "recovering", AUTH_BLOCKED: "auth-blocked" },
        computeRefreshRetryDelayMs: (attempt) => attempt * 1000,
        getManifestRefreshTimeoutMs: () => 10_000,
        logTabState: () => {},
        executeManifestRefreshAttempt: async () => true,
        requestManifestRefreshForTab: async () => true,
        isTabInScrubbingTrain: () => false,
        wasRecentlyScrubbing: () => false,
        blockPlaylistAuthRecovery: () => {},
        bumpManifestGeneration: (ts) => (ts.pendingManifestGeneration = Number(ts.pendingManifestGeneration || 0) + 1)
      }
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: () => {},
    chrome: { tabs: { sendMessage: async () => {} } },
    URL
  }
  sandbox.globalThis = sandbox
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
  return { ns: sandbox.self.AegisBackground, tabState, timers, logs }
}

// ── 1. Frame fan-out costs one retry, not four ───────────────────────────────
{
  const { ns, tabState } = makeHarness()
  for (let i = 0; i < 4; i += 1) ns.noteManifestRefreshFailed(1, 1, 0)
  assert(
    tabState.refreshRetryAttempt === 1,
    `4 frames reporting one generation must cost 1 retry, got ${tabState.refreshRetryAttempt}`
  )
  assert(tabState.refreshState === REFRESHING, "must not have given up after one round")
  console.log("  frame fan-out charged once: OK")
}

// ── 2. A new generation is chargeable again ──────────────────────────────────
{
  const { ns, tabState } = makeHarness()
  ns.noteManifestRefreshFailed(1, 1, 0)
  ns.noteManifestRefreshFailed(1, 1, 0)
  tabState.pendingManifestGeneration = 2
  ns.noteManifestRefreshFailed(1, 2, 0)
  ns.noteManifestRefreshFailed(1, 2, 0)
  assert(
    tabState.refreshRetryAttempt === 2,
    `two generations must cost 2 retries, got ${tabState.refreshRetryAttempt}`
  )
  console.log("  new generation chargeable: OK")
}

// ── 3. The budget is still finite ────────────────────────────────────────────
{
  const { ns, tabState } = makeHarness({ maxRetries: 5 })
  for (let gen = 1; gen <= 6; gen += 1) {
    tabState.pendingManifestGeneration = gen
    // Each round still fans out across frames.
    for (let frame = 0; frame < 4; frame += 1) ns.noteManifestRefreshFailed(1, gen, 0)
  }
  assert(
    tabState.refreshState === AUTH_EXPIRED,
    `exhausting ${5} retries must reach auth_expired, got ${tabState.refreshState}`
  )
  console.log("  budget still finite: OK")
}

// ── 4. auth_expired schedules a bounded self-heal ────────────────────────────
{
  const { ns, tabState, timers, logs } = makeHarness({ maxRetries: 1 })
  const before = timers.length
  tabState.pendingManifestGeneration = 1
  ns.noteManifestRefreshFailed(1, 1, 0)
  tabState.pendingManifestGeneration = 2
  ns.noteManifestRefreshFailed(1, 2, 0)
  assert(tabState.refreshState === AUTH_EXPIRED, "precondition: should be auth_expired")
  assert(
    logs.some((l) => l.includes("Auth-expired self-heal #1")),
    "entering auth_expired must schedule a self-heal probe"
  )
  const scheduled = timers.slice(before).find((t) => t.ms >= 30_000)
  assert(scheduled, "self-heal must be delayed past the retry cooldown")
  console.log("  auth_expired self-heal scheduled: OK")
}

// ── 5. Self-heal is bounded, not a permanent re-probe loop ───────────────────
{
  const { ns, tabState, logs } = makeHarness({ maxRetries: 1, selfHealAttempts: 2 })
  for (let round = 0; round < 6; round += 1) {
    tabState.refreshState = REFRESHING
    tabState.refreshRetryAttempt = 1
    tabState.pendingManifestGeneration = 100 + round
    ns.noteManifestRefreshFailed(1, 100 + round, 0)
  }
  const scheduledProbes = logs.filter((l) => l.includes("Auth-expired self-heal #")).length
  assert(
    scheduledProbes === 2,
    `self-heal must stop at the configured budget (2), scheduled ${scheduledProbes}`
  )
  assert(
    logs.some((l) => l.includes("Auth-expired self-heal exhausted")),
    "exhaustion must be logged rather than looping silently"
  )
  console.log("  self-heal bounded: OK")
}

console.log("manifest-refresh-retry-budget.test.js: OK")
