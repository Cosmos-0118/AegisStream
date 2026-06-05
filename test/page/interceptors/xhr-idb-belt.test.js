/**
 * Regression: IDB safety belt before network-native fallback.
 *
 * Trace evidence (the leak):
 *   T=33.481  Cache HIT background, bytes=1074108
 *   T=33.617  WRITEBACK-COMMITTED source=network-native bytes=1074108
 *   T=33.653  StoreChunk accepted: source=xhr-sync bytes=1074108
 *
 * Same URL, same byte count. The page-side `isLikelyCacheHitCandidate` returned
 * false (registry stale / not-yet-synced from background), so the XHR send path
 * skipped the IDB lookup and went straight to native CDN fetch — which then
 * re-stored the bytes as xhr-sync.
 *
 * Fix: before falling through to network-native on any path where
 * !cacheCandidate (or lookup IPC faults), do one bounded IDB lookup. IPC is
 * cheap; CDN multi-MB GETs aren't.
 *
 * This test models the decision tree of `fallbackToNativeWithBelt`.
 *
 * Run: node test/page/interceptors/xhr-idb-belt.test.js
 */
"use strict"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Simulates fallbackToNativeWithBelt without DOM/XHR. */
async function fallbackToNativeWithBelt({ lookupResult, beltLane = "test" }) {
  // Simulate one bounded IDB lookup (Promise.race vs 250ms timeout).
  const beltLookup = await Promise.race([
    Promise.resolve(lookupResult),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, hit: false, timeout: true }), 250))
  ])
  if (beltLookup?.timeout) {
    return { delivered: false, reason: "belt-timeout", lane: beltLane }
  }
  const beltBytes =
    beltLookup?.bytes ||
    (beltLookup?.ok && beltLookup?.hit ? beltLookup.payloadBytes || null : null)
  if (beltLookup?.ok && beltLookup.hit && beltBytes) {
    return { delivered: true, reason: "belt-hit", lane: beltLane, bytes: beltBytes }
  }
  return { delivered: false, reason: "belt-miss", lane: beltLane }
}

;(async () => {
  // Case A: IDB belt HIT — the exact leak scenario. Page registry was wrong,
  // but the bytes are in IDB. Belt must catch this and deliver, NOT proceed to
  // network-native.
  const beltHit = await fallbackToNativeWithBelt({
    lookupResult: {
      ok: true,
      hit: true,
      bytes: new ArrayBuffer(1074108),
      contentType: "video/mp2t"
    },
    beltLane: "not-candidate"
  })
  assert(beltHit.delivered === true, "belt must deliver on IDB hit")
  assert(beltHit.reason === "belt-hit", "belt-hit reason required")
  assert(
    beltHit.bytes.byteLength === 1074108,
    "belt must surface the cached bytes (the network-native re-fetch is what we avoided)"
  )

  // Case B: IDB belt MISS — bytes really are absent. Caller must proceed to
  // network-native (this is the only acceptable network-native trigger).
  const beltMiss = await fallbackToNativeWithBelt({
    lookupResult: { ok: true, hit: false },
    beltLane: "not-candidate"
  })
  assert(beltMiss.delivered === false, "belt must NOT deliver on IDB miss")
  assert(beltMiss.reason === "belt-miss", "belt-miss reason required")

  // Case C: Lookup IPC fault path — belt failed cleanly. Caller falls through.
  const beltFault = await fallbackToNativeWithBelt({
    lookupResult: { ok: false, error: "ipc-fault" },
    beltLane: "lookup-ipc-fault"
  })
  assert(beltFault.delivered === false, "belt must NOT deliver on IPC fault")

  console.log("xhr-idb-belt.test.js: all assertions passed")
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
