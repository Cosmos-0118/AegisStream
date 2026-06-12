/**
 * Regression: pause / tab-switch / SW restart must recapture playlist before serving cache.
 *
 * Run: node test/background/prefetch/policy/playlist-recovery.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const runtimeStatePath = path.join(__dirname, "../../../../src/background/state/runtime-state.js")
const tabPolicyPath = path.join(__dirname, "../../../../src/background/prefetch/policy/tab-policy.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeSandbox() {
  const refreshCalls = []
  const prefetchCalls = []
  const sandbox = {
    URL,
    self: {
      AegisBackground: {
        constants: {
          PLAYLIST_IDLE_STALE_MS: 120_000,
          PLAYLIST_RECOVERY_DEBOUNCE_MS: 5_000,
          VISIBILITY_PLAYLIST_REFRESH_MS: 30_000,
          PREFETCH_INFLIGHT_TTL_MS: 12_000,
          WARM_RECOVERY_DEFER_PREFETCH_MS: 10,
          WARM_RECOVERY_RUNG_CONFIRM_MS: 10_000,
          STATE_PERSIST_DEBOUNCE_MS: 50,
          STATE_PERSIST_MAX_TABS: 8,
          VARIANT_SWITCH_PREFETCH_WINDOW: 12,
          DEFAULT_SETTINGS: { maxEntries: 500, prefetchWindow: 8 },
          createInitialStats: () => ({})
        },
        state: {
          settings: { enabled: true, prefetchEnabled: true, prefetchWindow: 8 },
          playlistByTab: new Map(),
          pendingPrefetchByTab: new Map(),
          inflightPrefetches: new Map(),
          tabAnchorJumps: new Map(),
          activePrefetchTabId: null,
          bridgeHeartbeatByTab: new Map(),
          workerLifecycle: { startCount: 2, lastStartedAt: Date.now() - 60_000 },
          logs: [],
          stats: {}
        },
        addLog: () => {},
        tabNeedsPlaylistRecovery: (tabState, options = {}) => {
          if (!tabState) return false
          const playlistUrl = tabState.mediaPlaylistUrl || tabState.lastMediaPlaylistUrl
          if (!playlistUrl) return false
          const segmentsEmpty = !tabState.segments?.length
          const staleMs = 120_000
          const lastActiveAt = Math.max(
            Number(tabState.updatedAt || 0),
            Number(tabState.warmRecoveryAppliedAt || 0)
          )
          const idleStale = lastActiveAt > 0 && Date.now() - lastActiveAt > staleMs
          if (tabState.warmRecovery && segmentsEmpty) return true
          if (tabState.playlistRecaptureRequired) return true
          if (segmentsEmpty) return true
          if (options.forceAfterIdle && idleStale) return true
          const hiddenMs = Number(options.hiddenDurationMs || 0)
          if (options.forceAfterIdle && hiddenMs >= 30_000) return true
          return false
        },
        maybeRequestPrefetchForTab: (...args) => prefetchCalls.push(args),
        recordDecision: () => {}
      }
    },
    chrome: {
      storage: {
        session: {
          set: async () => undefined,
          get: async () => ({})
        },
        local: { get: async () => ({}), set: async () => undefined }
      }
    },
    setTimeout: (fn, ms) => {
      setTimeoutCalls.push(ms)
      fn()
      return 1
    },
    clearTimeout: () => {}
  }
  sandbox.globalThis = sandbox
  sandbox.self.AegisBackground.ensureTabPlaylistRecovery = async (tabId, reason, options = {}) => {
    if (!options.force) {
      const tabState = sandbox.self.AegisBackground.state.playlistByTab.get(tabId)
      if (!sandbox.self.AegisBackground.tabNeedsPlaylistRecovery(tabState, options)) {
        return false
      }
    }
    refreshCalls.push({ tabId, reason, options })
    return true
  }
  return { sandbox, refreshCalls, prefetchCalls }
}

let setTimeoutCalls = []

function loadRuntimeState(sandbox) {
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(runtimeStatePath, "utf8"), ctx)
  return sandbox.self.AegisBackground
}

function loadTabPolicy(sandbox) {
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(tabPolicyPath, "utf8"), ctx)
  return sandbox.self.AegisBackground
}

function testWarmRecoveryRestoresPlaylistUrl() {
  setTimeoutCalls = []
  const { sandbox } = makeSandbox()
  const api = loadRuntimeState(sandbox)

  const applied = api.applyWarmRecoverySnapshot({
    entries: [
      {
        tabId: 42,
        mediaPlaylistUrl: "https://cdn.example.com/media.m3u8",
        lastSegmentCount: 120,
        anchorIndex: 10,
        hasAnchor: true,
        updatedAt: Date.now() - 300_000
      }
    ]
  })
  assert(applied === 1, "expected one tab restored")
  const tabState = api.state.playlistByTab.get(42)
  assert(tabState.mediaPlaylistUrl === "https://cdn.example.com/media.m3u8", "mediaPlaylistUrl restored")
  assert(tabState.segments.length === 0, "segments stripped on warm recovery")
  assert(tabState.warmRecovery === true, "warm recovery flagged")
}

function testVisibilityResumeTriggersRecoveryAfterWarmRecovery() {
  setTimeoutCalls = []
  const { sandbox, refreshCalls } = makeSandbox()
  const api = loadTabPolicy(sandbox)

  api.state.playlistByTab.set(7, {
    segments: [],
    warmRecovery: true,
    mediaPlaylistUrl: "https://cdn.example.com/v.m3u8",
    hasAnchor: true,
    anchorIndex: 5,
    visibilitySleepActive: false
  })

  api.resumeTabPrefetchForVisibility(7, "tab-visible")
  assert(refreshCalls.length === 1, "expected playlist recovery on visibility resume")
  assert(refreshCalls[0].reason === "tab-visible", "recovery reason preserved")
}

function testVisibilityResumePrefetchesWhenSegmentsPresent() {
  const { sandbox, refreshCalls, prefetchCalls } = makeSandbox()
  const api = loadTabPolicy(sandbox)

  api.state.playlistByTab.set(8, {
    segments: ["https://cdn.example.com/a.ts"],
    updatedAt: Date.now(),
    hasAnchor: true,
    anchorIndex: 2,
    visibilitySleepActive: true
  })

  api.resumeTabPrefetchForVisibility(8, "tab-visible")
  assert(refreshCalls.length === 0, "no recovery when segments exist and fresh")
  assert(prefetchCalls.length === 1, "prefetch warmed on visibility resume")
}

function testVisibilityResumeTriggersRecoveryAfterLongHidden() {
  const { sandbox, refreshCalls } = makeSandbox()
  const api = loadTabPolicy(sandbox)

  api.state.playlistByTab.set(9, {
    segments: ["https://cdn.example.com/a.ts"],
    updatedAt: Date.now(),
    mediaPlaylistUrl: "https://cdn.example.com/v.m3u8",
    hasAnchor: true,
    anchorIndex: 2,
    visibilitySleepActive: true,
    visibilitySleepAt: Date.now() - 45_000
  })

  api.resumeTabPrefetchForVisibility(9, "tab-visible")
  assert(refreshCalls.length === 1, "expected playlist recovery after long hidden")
}

testWarmRecoveryRestoresPlaylistUrl()
testVisibilityResumeTriggersRecoveryAfterWarmRecovery()
testVisibilityResumeTriggersRecoveryAfterLongHidden()
testVisibilityResumePrefetchesWhenSegmentsPresent()

console.log("playlist-recovery.test.js: all tests passed")
