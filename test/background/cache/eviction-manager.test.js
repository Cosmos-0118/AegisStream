/**
 * Run: node test/background/cache/eviction-manager.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function load(relativePath) {
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../../src", relativePath), "utf8"),
    vm.createContext(sandbox)
  )
}

const activityBumps = []

const sandbox = {
  self: {},
  AegisBackground: {
    bumpActivity(metric, amount = 1) {
      activityBumps.push({ metric, amount })
    },
    constants: {
      CACHE_EVICTION_SOFT_BYTES_RATIO: 0.85,
      CACHE_EVICTION_SOFT_ENTRIES_RATIO: 0.9,
      CACHE_EVICTION_HARD_BYTES_RATIO: 0.95,
      CACHE_EVICTION_HARD_ENTRIES_RATIO: 0.95,
      CACHE_EVICTION_LANE3_MIN_RATIO: 0.7,
      CACHE_EVICTION_SCRUB_DEFER_MS: 5_000,
      CACHE_EVICTION_DEBOUNCE_MS: 2_000,
      CACHE_EVICTION_LANE3_INTERVAL_MS: 45_000
    },
    state: {
      playlistByTab: new Map()
    },
    isScrubbingTrainActive: (tabState) =>
      Date.now() < Number(tabState?.scrubbingTrainUntil || 0),
    isTabInSeekChurnAggressive: (tabState) =>
      Date.now() < Number(tabState?.seekChurnAggressiveUntil || 0)
  }
}
sandbox.self.AegisBackground = sandbox.AegisBackground

load("background/cache/eviction-manager.js")

const ns = sandbox.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const policy = { maxBytes: 1000, maxEntries: 100 }

const low = ns.evaluateCachePressureRatios({ totalBytes: 150, totalEntries: 20 }, policy)
assert(low.overSoftThreshold === false, "15% fill should not trigger soft threshold")
assert(low.lane3Eligible === false, "15% fill should skip lane 3")

const mid = ns.evaluateCachePressureRatios({ totalBytes: 900, totalEntries: 50 }, policy)
assert(mid.overSoftThreshold === true, "90% bytes should trigger soft threshold")
assert(mid.overHardThreshold === false, "90% bytes should remain below hard threshold")
assert(mid.lane3Eligible === true, "90% fill should allow lane 3")

const hard = ns.evaluateCachePressureRatios({ totalBytes: 960, totalEntries: 96 }, policy)
assert(hard.overHardThreshold === true, "96% should trigger hard threshold")

ns.state.activePrefetchTabId = 1
ns.state.playlistByTab.set(1, { scrubbingTrainUntil: Date.now() + 10_000 })
assert(
  ns.shouldScheduleSoftEviction(mid) === false,
  "soft eviction should suppress during scrub below hard threshold"
)
assert(
  ns.shouldScheduleSoftEviction(hard) === true,
  "hard threshold should schedule even during scrub"
)

ns.state.playlistByTab.set(1, { scrubbingTrainUntil: Date.now() + 10_000 })
assert(ns.isAnyTabEvictionSuppressed() === true, "scrub train should suppress eviction")

ns.state.playlistByTab.set(1, { seekChurnAggressiveUntil: Date.now() + 10_000 })
assert(ns.isAnyTabEvictionSuppressed() === true, "seek churn should suppress eviction")

ns.state.playlistByTab.clear()
assert(ns.isAnyTabEvictionSuppressed() === false, "steady state should not suppress eviction")

// Phase 1 correctness matrix
ns.state.playlistByTab.clear()
ns.state.activePrefetchTabId = null
activityBumps.length = 0

// Test A: Steady state — no scrub, below soft threshold → no soft eviction scheduled
assert(
  ns.shouldScheduleSoftEviction(low) === false,
  "Test A: steady playback should not schedule soft eviction below 85%"
)
assert(
  activityBumps.filter((b) => b.metric === "evictionSuppressedByScrub").length === 0,
  "Test A: evictionSuppressedByScrub should remain 0 in steady state"
)

// Scrub below soft threshold must not emit suppression telemetry
ns.state.activePrefetchTabId = 2
ns.state.playlistByTab.set(2, { scrubbingTrainUntil: Date.now() + 10_000 })
ns.resetSuppressionTelemetryCooldown()
activityBumps.length = 0
assert(ns.shouldScheduleSoftEviction(low) === false, "scrub below soft threshold should not schedule")
assert(
  activityBumps.filter((b) => b.metric === "evictionSuppressedByScrub").length === 0,
  "scrub below soft threshold must not bump evictionSuppressedByScrub"
)

// Test B: Timeline drag — scrub active, soft threshold crossed → suppress, do not schedule
assert(
  ns.shouldScheduleSoftEviction(mid) === false,
  "Test B: aggressive scrub should block soft eviction scheduling"
)

// Test C: Storage crunch — scrub active, hard threshold crossed → schedule immediately
assert(
  ns.shouldScheduleSoftEviction(hard) === true,
  "Test C: hard threshold must bypass scrub suppression at >= 95%"
)

// Test B telemetry: single source of truth bumps once per suppression window
activityBumps.length = 0
ns.resetSuppressionTelemetryCooldown()
assert(ns.shouldScheduleSoftEviction(mid) === false, "Test B: scrub blocks scheduling")
assert(
  activityBumps.filter((b) => b.metric === "evictionSuppressedByScrub").length === 1,
  "Test B: evictionSuppressedByScrub should increment once on first suppress"
)
ns.shouldScheduleSoftEviction(mid)
assert(
  activityBumps.filter((b) => b.metric === "evictionSuppressedByScrub").length === 1,
  "Test B: rapid chunk stores within cooldown must not inflate suppression counter"
)

console.log("eviction-manager.test.js: all assertions passed (Phase 1 matrix A–C)")
