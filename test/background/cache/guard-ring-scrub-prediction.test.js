/**
 * During a scrub train the guard ring must protect the union of the live
 * anchor window and the predicted-anchor window, never replace the live
 * window outright — and only when the prediction is still fresh
 * (predictedAnchorAt within ANCHOR_SIGNAL_FRESH_MS). A stale or wrong
 * prediction must not leave the real playhead unprotected during scrubbing.
 *
 * Run: node test/background/cache/guard-ring-scrub-prediction.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeSandbox(tabStateOverrides, { isTabInScrubbingTrain = () => true } = {}) {
  const sandbox = {
    self: {},
    AegisBackground: {
      constants: {
        CACHE_GUARD_RING_PAST_SEGMENTS: 2,
        CACHE_GUARD_RING_FUTURE_SEGMENTS: 12,
        CACHE_GUARD_RING_SEEK_CHURN_PAST: 5,
        CACHE_GUARD_RING_SEEK_CHURN_FUTURE: 24,
        ANCHOR_SIGNAL_FRESH_MS: 3_000
      },
      state: {
        playlistByTab: new Map([
          [
            1,
            {
              segments: new Array(60).fill(0).map((_, i) => `https://cdn.example.com/seg-${i}.ts`),
              anchorIndex: 20,
              hasAnchor: true,
              ...tabStateOverrides
            }
          ]
        ]),
        inflightPrefetches: new Map()
      },
      stripHash: (url) => (typeof url === "string" ? url.split("#")[0] : null),
      buildCacheKeyVariants: (url) => [url],
      resolveSegmentIndexInManifest: () => null,
      isTabInScrubbingTrain
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

// Fresh prediction: protect BOTH the live anchor window and the predicted window.
{
  const ns = makeSandbox({ predictedAnchorIndex: 45, predictedAnchorAt: Date.now() })
  const protectedSet = ns.collectGuardRingProtectedUrls()
  assert(
    protectedSet.has("https://cdn.example.com/seg-20.ts"),
    "live anchor (20) must remain protected even when a fresh prediction exists elsewhere"
  )
  assert(
    protectedSet.has("https://cdn.example.com/seg-45.ts"),
    "fresh predicted anchor (45) must also be protected"
  )
}

// Stale prediction: must NOT be used at all; only the live anchor window applies.
{
  const ns = makeSandbox({
    predictedAnchorIndex: 45,
    predictedAnchorAt: Date.now() - 10_000 // older than ANCHOR_SIGNAL_FRESH_MS
  })
  const protectedSet = ns.collectGuardRingProtectedUrls()
  assert(
    protectedSet.has("https://cdn.example.com/seg-20.ts"),
    "live anchor (20) must be protected"
  )
  assert(
    !protectedSet.has("https://cdn.example.com/seg-45.ts"),
    "a stale prediction must not extend protection to its (possibly wrong) target"
  )
}

// No scrub train active: predictedAnchorIndex must be ignored entirely.
{
  const ns = makeSandbox(
    { predictedAnchorIndex: 45, predictedAnchorAt: Date.now() },
    { isTabInScrubbingTrain: () => false }
  )
  const protectedSet = ns.collectGuardRingProtectedUrls()
  assert(protectedSet.has("https://cdn.example.com/seg-20.ts"), "live anchor must be protected")
  assert(
    !protectedSet.has("https://cdn.example.com/seg-45.ts"),
    "predicted anchor must not apply outside of a scrub train"
  )
}

console.log("guard-ring-scrub-prediction.test.js: all assertions passed")
