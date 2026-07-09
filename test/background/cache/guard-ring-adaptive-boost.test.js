/**
 * The adaptive hit-rate boost widens the *prefetch* window (see
 * prefetch-scheduler.js's resolveAdaptiveHitRateBoost), but those extra
 * fetched chunks are only useful if eviction doesn't reclaim them before
 * playback reaches them. The guard ring must extend its protected radius by
 * the same amount, otherwise the wider prefetch just becomes wasted fill
 * (visible as recentlyEvictedMisses) instead of raising the real hit rate.
 *
 * Run: node test/background/cache/guard-ring-adaptive-boost.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeSandbox(resolveAdaptiveHitRateBoost) {
  const sandbox = {
    self: {},
    AegisBackground: {
      constants: {
        CACHE_GUARD_RING_PAST_SEGMENTS: 2,
        CACHE_GUARD_RING_FUTURE_SEGMENTS: 12,
        CACHE_GUARD_RING_SEEK_CHURN_PAST: 5,
        CACHE_GUARD_RING_SEEK_CHURN_FUTURE: 24,
        TIMELINE_HEAT_WEIGHT_HISTORICAL: 4
      },
      state: {
        playlistByTab: new Map([
          [
            1,
            {
              segments: new Array(60).fill(0).map((_, i) => `https://cdn.example.com/seg-${i}.ts`),
              anchorIndex: 20,
              hasAnchor: true
            }
          ]
        ]),
        inflightPrefetches: new Map()
      },
      stripHash: (url) => (typeof url === "string" ? url.split("#")[0] : null),
      buildCacheKeyVariants: (url) => [url],
      resolveSegmentIndexInManifest: () => null,
      resolveAdaptiveHitRateBoost
    },
    URL
  }
  sandbox.self.AegisBackground = sandbox.AegisBackground
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../../src/background/cache/guard-ring.js"), "utf8"),
    vm.createContext(sandbox)
  )
  return sandbox.AegisBackground
}

// Baseline: no adaptive boost function wired (defensive default) -> unchanged radius.
{
  const ns = makeSandbox(undefined)
  const protectedSet = ns.collectGuardRingProtectedUrls()
  assert(protectedSet.has("https://cdn.example.com/seg-32.ts"), "default future radius (12) should protect index 32")
  assert(!protectedSet.has("https://cdn.example.com/seg-33.ts"), "default future radius should not extend past index 32")
}

// A struggling tab (boost = 4) should get a wider protected ring in both directions.
{
  const ns = makeSandbox(() => 4)
  const protectedSet = ns.collectGuardRingProtectedUrls()
  assert(protectedSet.has("https://cdn.example.com/seg-36.ts"), "boosted future radius (12+4) should protect index 36")
  assert(!protectedSet.has("https://cdn.example.com/seg-37.ts"), "boosted future radius should not overshoot")
  assert(protectedSet.has("https://cdn.example.com/seg-16.ts"), "boosted past radius (2+ceil(4/2)) should protect index 16")
}

console.log("guard-ring-adaptive-boost.test.js: all assertions passed")
