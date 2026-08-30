/**
 * Regression: auth_expired must not permanently stop prefetch.
 *
 * Field failure: auth_expired means the *manifest endpoint* refused us. The
 * segment URLs already in hand are usually unaffected — in the observed session
 * they were signed with x-expires in 2027. Treating the two as the same thing
 * made the state self-sustaining: prefetch stopped, so the cache never refilled,
 * so every player lookup missed, and the miss path deliberately skips recovery
 * to avoid a miss-loop. Nothing was left to break the cycle. Over one 2.6-minute
 * session the player issued 57 cache lookups and was served 8; the other 49
 * arrived after the tab latched auth_expired with an empty cache and prefetch=0.
 *
 * Contract:
 *  1. auth_expired with a held segment list still allows prefetch.
 *  2. auth_expired with no segment list still blocks (nothing to prefetch).
 *  3. The allowance is bounded: once failures reach the budget it blocks again,
 *     so genuinely rotated URLs are not hammered forever.
 *  4. A successful prefetch clears the failure count, so a tab that recovers
 *     gets its full allowance back.
 *  5. Unrelated blocking reasons are untouched.
 *
 * Run: node test/background/prefetch/anchor/stale-manifest-prefetch.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const modulePath = path.join(
  __dirname,
  "../../../../src/background/prefetch/anchor/anchor-utils.js"
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const AUTH_EXPIRED = "auth_expired"
const REFRESHING = "refreshing"
const BUDGET = 8

function makeHarness() {
  const sandbox = {
    self: {
      AegisBackground: {
        constants: {
          AUTH_EXPIRED_PREFETCH_FAILURE_BUDGET: BUDGET,
          SCRUBBING_TRAIN_IDLE_MS: 1000
        },
        state: { playlistByTab: new Map() },
        addLog: () => {},
        REFRESH_STATE_AUTH_EXPIRED: AUTH_EXPIRED,
        REFRESH_STATE_REFRESHING: REFRESHING,
        isTabInScrubbingTrain: () => false
      }
    },
    console
  }
  sandbox.globalThis = sandbox
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
  return sandbox.self.AegisBackground
}

const segments = ["https://cdn.example.com/0001.ts", "https://cdn.example.com/0002.ts"]

// ── 1 & 2. auth_expired: allowed with segments, blocked without ─────────────
{
  const ns = makeHarness()
  assert(
    ns.isPrefetchBlocked({ refreshState: AUTH_EXPIRED, segments }) === false,
    "auth_expired with a held segment list MUST still allow prefetch — otherwise the cache can never refill and every lookup misses forever"
  )
  assert(
    ns.isPrefetchBlocked({ refreshState: AUTH_EXPIRED, segments: [] }) === true,
    "auth_expired with no segment list has nothing to prefetch and must block"
  )
  console.log("  allowed with segments, blocked without: OK")
}

// ── 3. Bounded ──────────────────────────────────────────────────────────────
{
  const ns = makeHarness()
  const tabState = { refreshState: AUTH_EXPIRED, segments, authExpiredPrefetchFailures: BUDGET - 1 }
  assert(ns.isPrefetchBlocked(tabState) === false, "just under budget must still be allowed")
  tabState.authExpiredPrefetchFailures = BUDGET
  assert(
    ns.isPrefetchBlocked(tabState) === true,
    "at the failure budget the URLs really have rotated; prefetch must stand down"
  )
  console.log("  allowance is bounded: OK")
}

// ── 4. Success restores the allowance ───────────────────────────────────────
{
  const ns = makeHarness()
  const tabState = { refreshState: AUTH_EXPIRED, segments, authExpiredPrefetchFailures: BUDGET }
  assert(ns.isPrefetchBlocked(tabState) === true, "precondition: exhausted")
  tabState.authExpiredPrefetchFailures = 0
  assert(
    ns.isPrefetchBlocked(tabState) === false,
    "clearing the failure count (a segment fetched fine) must restore the allowance"
  )
  console.log("  success restores allowance: OK")
}

// ── 5. Other blocking reasons untouched ─────────────────────────────────────
{
  const ns = makeHarness()
  assert(
    ns.isPrefetchBlocked({ refreshState: REFRESHING, segments }) === true,
    "an in-flight refresh must still block"
  )
  assert(
    ns.isPrefetchBlocked({ segments, manifestRefreshPending: true }) === true,
    "a pending manifest refresh must still block"
  )
  assert(
    ns.isPrefetchBlocked({ segments, prefetchPausedUntil: Date.now() + 5000 }) === true,
    "an explicit prefetch pause must still block"
  )
  assert(ns.isPrefetchBlocked({ segments }) === false, "a healthy tab must not be blocked")
  console.log("  other blocking reasons untouched: OK")
}

console.log("stale-manifest-prefetch.test.js: OK")
