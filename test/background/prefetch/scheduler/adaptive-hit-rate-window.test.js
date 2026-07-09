/**
 * Covers the closed-loop adaptive prefetch window boost: the prefetch window
 * must widen automatically when a tab's *observed* rolling hit rate
 * (tabState.prefetchHitRate / prefetchHitRateSamples, populated by
 * updateTabPrefetchHitRate in activity-metrics.js) drops below target —
 * independent of buffer runway or discrete seek-jump thresholds. This is
 * what makes the extension self-correct for an aggressive (frequent-seek)
 * user instead of only reacting after playback has already stalled.
 *
 * Run: node test/background/prefetch/scheduler/adaptive-hit-rate-window.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const schedulerPath = path.join(
  __dirname,
  "../../../../src/background/prefetch/scheduler/prefetch-scheduler.js"
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeSandbox() {
  const sandbox = {
    self: {},
    AegisBackground: {
      constants: {
        PREFETCH_ADAPTIVE_MIN_SAMPLES: 3,
        PREFETCH_ADAPTIVE_HIT_TARGET: 0.88,
        PREFETCH_ADAPTIVE_MAX_WINDOW_BOOST: 4,
        PREFETCH_TAB_BURST_THRESHOLD: 8,
        PREFETCH_BURST_WINDOW_CAP: 8,
        BUFFER_RUNWAY_EMERGENCY_SEC: 5,
        BUFFER_RUNWAY_AGGRESSIVE_SEC: 15,
        SEEK_PASSENGER_STALL_RUNWAY_SEC: 4,
        VARIANT_SWITCH_PREFETCH_WINDOW: 12,
        SEEK_CHURN_PREFETCH_WINDOW_MIN: 10,
        PREFETCH_INFLIGHT_RETRY_MS: 500,
        PREFETCH_CAP_RETRY_MAX_ATTEMPTS: 10,
        PREFETCH_DUPLICATE_WINDOW_MS: 1200
      },
      state: {
        settings: { prefetchWindow: 6, enabled: true, prefetchEnabled: true },
        playlistByTab: new Map(),
        failedPrefetches: new Map(),
        inflightPrefetches: new Map(),
        pendingPrefetchByTab: new Map()
      },
      addLog: () => {},
      // Unguarded call sites inside resolveEffectivePrefetchWindow — must exist.
      isTabInVariantSwitchGrace: () => false,
      isTabInSeekChurnAggressive: () => false,
      isPrefetchBlocked: () => false,
      computeCapRetryDelayMs: () => 200
    },
    URL
  }
  sandbox.self.AegisBackground = sandbox.AegisBackground
  vm.runInContext(fs.readFileSync(schedulerPath, "utf8"), vm.createContext(sandbox))
  return sandbox.AegisBackground
}

// ── resolveAdaptiveHitRateBoost: pure boost math ──
{
  const ns = makeSandbox()

  assert(
    ns.resolveAdaptiveHitRateBoost({ prefetchHitRateSamples: 2, prefetchHitRate: 0.1 }) === 0,
    "below min-sample count should not trust the signal yet"
  )

  assert(
    ns.resolveAdaptiveHitRateBoost({ prefetchHitRateSamples: 5, prefetchHitRate: 0.95 }) === 0,
    "hit rate already above target should not boost"
  )

  assert(
    ns.resolveAdaptiveHitRateBoost({ prefetchHitRateSamples: 5, prefetchHitRate: 0.7 }) === 2,
    "70% hit rate (0.18 deficit) should add a modest boost"
  )

  assert(
    ns.resolveAdaptiveHitRateBoost({ prefetchHitRateSamples: 5, prefetchHitRate: 0.3 }) === 4,
    "large deficit should clamp to PREFETCH_ADAPTIVE_MAX_WINDOW_BOOST"
  )

  assert(
    ns.resolveAdaptiveHitRateBoost({ prefetchHitRateSamples: 5, prefetchHitRate: NaN }) === 0,
    "non-finite hit rate should not boost"
  )
}

// ── resolveEffectivePrefetchWindow: boost folds into the base window
//    unconditionally (not gated behind buffer-runway pressure) ──
{
  const ns = makeSandbox()
  const tabId = 1
  ns.state.playlistByTab.set(tabId, {
    segments: new Array(50).fill(0).map((_, i) => `https://cdn.example.com/seg-${i}.ts`),
    anchorIndex: 10,
    hasAnchor: true,
    prefetchHitRateSamples: 6,
    prefetchHitRate: 0.5, // struggling tab, but buffer runway is healthy (no pressure elsewhere)
    bufferRunwaySec: 60
  })

  const boosted = ns.resolveEffectivePrefetchWindow(tabId)
  assert(
    boosted === 6 + 4,
    `struggling tab with healthy runway should still widen window via hit-rate boost, got ${boosted}`
  )
}

{
  const ns = makeSandbox()
  const tabId = 2
  ns.state.playlistByTab.set(tabId, {
    segments: new Array(50).fill(0).map((_, i) => `https://cdn.example.com/seg-${i}.ts`),
    anchorIndex: 10,
    hasAnchor: true,
    prefetchHitRateSamples: 6,
    prefetchHitRate: 0.95, // healthy tab
    bufferRunwaySec: 60
  })

  const window = ns.resolveEffectivePrefetchWindow(tabId)
  assert(window === 6, `healthy tab should keep the base window unboosted, got ${window}`)
}

console.log("adaptive-hit-rate-window.test.js: all assertions passed")
