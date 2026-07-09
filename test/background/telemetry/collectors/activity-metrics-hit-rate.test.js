/**
 * Covers the per-tab rolling hit-rate signal that feeds the adaptive
 * prefetch-window boost (resolveAdaptiveHitRateBoost in
 * prefetch-scheduler.js). Before this, tabState.prefetchHitRate /
 * prefetchHitRateSamples were read by the scheduler but never written by
 * anything — the boost was permanently dead. recordCacheServeHit /
 * recordCacheLookupMiss must now populate it whenever `meta.tabId` is given.
 *
 * Run: node test/background/telemetry/collectors/activity-metrics-hit-rate.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const activityMetricsPath = path.join(
  __dirname,
  "../../../../src/background/telemetry/collectors/activity-metrics.js"
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sandbox = {
  self: {},
  AegisBackground: {
    constants: {
      PREFETCH_ADAPTIVE_HIT_RATE_ALPHA: 0.25
    },
    state: {
      stats: {},
      playlistByTab: new Map([[1, {}]])
    }
  }
}
sandbox.self.AegisBackground = sandbox.AegisBackground
vm.runInContext(fs.readFileSync(activityMetricsPath, "utf8"), vm.createContext(sandbox))

const ns = sandbox.AegisBackground
const tabState = ns.state.playlistByTab.get(1)

// No tabId in meta: must not throw, and must not touch any tabState.
ns.recordCacheServeHit("https://cdn.example.com/seg-0.ts", {})
assert(tabState.prefetchHitRate === undefined, "missing tabId must not touch tabState")

// First sample seeds the EWMA directly (no smoothing artifact on sample 1).
ns.recordCacheServeHit("https://cdn.example.com/seg-1.ts", { tabId: 1 })
assert(tabState.prefetchHitRateSamples === 1, "first sample should be counted")
assert(tabState.prefetchHitRate === 1, "first hit should seed hit rate at 1")

// A miss should pull the EWMA down, not just decrement a naive counter.
ns.recordCacheLookupMiss("https://cdn.example.com/seg-2.ts", { tabId: 1 })
assert(tabState.prefetchHitRateSamples === 2, "second sample should be counted")
assert(
  Math.abs(tabState.prefetchHitRate - 0.75) < 1e-9,
  `EWMA after hit,miss should be 0.75 alpha-blended, got ${tabState.prefetchHitRate}`
)

// A run of misses should keep dragging the rolling rate down (not floor it).
for (let i = 0; i < 10; i += 1) {
  ns.recordCacheLookupMiss(`https://cdn.example.com/seg-miss-${i}.ts`, { tabId: 1 })
}
assert(tabState.prefetchHitRate < 0.1, `sustained misses should crater the rolling rate, got ${tabState.prefetchHitRate}`)
assert(tabState.prefetchHitRateSamples === 12, "sample count should keep accumulating")

// Unknown tab id must be a no-op, not a throw.
ns.recordCacheServeHit("https://cdn.example.com/seg-3.ts", { tabId: 999 })

console.log("activity-metrics-hit-rate.test.js: all assertions passed")
