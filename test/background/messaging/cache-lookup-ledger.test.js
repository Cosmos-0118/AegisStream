/**
 * Regression: one cache lookup in, exactly one outcome out.
 *
 * Field failure: 49 of 65 lookups in a single session produced no outcome at
 * all. The service worker's own running counters read
 * `lookups=65 hits=16 misses=0` — the handler incremented cacheLookups, then
 * stalled on an unbounded IndexedDB await and never reached any accounting
 * branch. Two failures fell out of that, and the second is the dangerous one:
 * playback lost the cache, and cacheHitRatePercent = hits/(hits+misses) silently
 * became hits/hits, so it could only ever print 100% or n/a. A metric that can
 * only report success gets acted on.
 *
 * Contract:
 *  1. lookups == hits + misses, always. That is the whole point.
 *  2. Settling is idempotent — a path that records twice cannot inflate.
 *  3. A handler that finishes without settling is booked as a miss AND flagged
 *     in cacheLookupUnaccounted, which must stay 0 in a healthy build.
 *  4. A handler that hangs is answered by the watchdog so the player falls back
 *     to network instead of stalling, and the lookup is booked as a miss.
 *  5. The caller is answered exactly once, whatever happens.
 *  6. A lookup that exits before the ledger opens is not counted at all.
 *
 * Run: node test/background/messaging/cache-lookup-ledger.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const R = path.join(__dirname, "../../..")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Loads the real constants + activity-metrics, then the real ledger factory. */
function makeHarness() {
  const sandbox = {
    console, Date, Math, Number, String, Object, Map, Set, Array, JSON, Promise,
    setTimeout, clearTimeout, URL, TextEncoder, TextDecoder
  }
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/config/constants.js"), "utf8"), ctx)
  const ns = sandbox.self.AegisBackground
  ns.state = { stats: ns.constants.createInitialStats(), settings: {}, playlistByTab: new Map() }
  vm.runInContext(
    fs.readFileSync(path.join(R, "src/background/telemetry/collectors/activity-metrics.js"), "utf8"),
    ctx
  )

  // The ledger factory verbatim out of message-router, with its dependencies
  // bound to the real recorders above.
  const src = fs.readFileSync(path.join(R, "src/background/messaging/message-router.js"), "utf8")
  const start = src.indexOf("const LOOKUP_WATCHDOG_MS")
  const end = src.indexOf("ns.createLookupLedger = createLookupLedger")
  assert(start > 0 && end > start, "could not extract createLookupLedger from message-router.js")
  vm.runInContext(
    `(() => { const ns = self.AegisBackground;
      const { bumpActivity, recordCacheServeHit, recordCacheLookupMiss } = ns;
      const addLog = () => {};
      ${src.slice(start, end)}
      ns.createLookupLedger = createLookupLedger })()`,
    ctx
  )
  return { ns, stats: ns.state.stats }
}

function collect() {
  const replies = []
  return { replies, sendResponse: (p) => replies.push(p) }
}

// ── 1 & 2. Normal outcomes, idempotent ──────────────────────────────────────
{
  const { ns, stats } = makeHarness()
  const a = collect()
  const hit = ns.createLookupLedger(a.sendResponse, 1, { url: "https://x/a.ts" })
  hit.open()
  hit.settle("hit")
  hit.settle("hit")        // a second recording must not inflate
  hit.settle("miss")       // nor may a later path reclassify it
  hit.respond({ ok: true, hit: true })
  hit.finalize()

  const b = collect()
  const miss = ns.createLookupLedger(b.sendResponse, 1, { url: "https://x/b.ts" })
  miss.open()
  miss.settle("miss")
  miss.finalize()

  assert(stats.cacheLookups === 2, `expected 2 lookups, got ${stats.cacheLookups}`)
  assert(stats.cacheHits === 1, `expected 1 hit, got ${stats.cacheHits}`)
  assert(stats.cacheMisses === 1, `expected 1 miss, got ${stats.cacheMisses}`)
  assert(
    stats.cacheLookups === stats.cacheHits + stats.cacheMisses,
    "lookups must reconcile against hits+misses"
  )
  assert(stats.cacheLookupUnaccounted === 0, "clean outcomes must not flag unaccounted")
  assert(a.replies.length === 1 && b.replies.length === 1, "each lookup must be answered exactly once")
  console.log("  outcomes recorded once and reconcile: OK")
}

// ── 3. Finishing without settling is caught, not lost ───────────────────────
{
  const { ns, stats } = makeHarness()
  const c = collect()
  const led = ns.createLookupLedger(c.sendResponse, 1, { url: "https://x/c.ts" })
  led.open()
  led.finalize()   // handler returned without ever recording an outcome

  assert(stats.cacheLookups === 1, `expected 1 lookup, got ${stats.cacheLookups}`)
  assert(
    stats.cacheMisses === 1,
    "a lookup that never settled certainly was not a hit and must be booked as a miss"
  )
  assert(
    stats.cacheLookupUnaccounted === 1,
    "the drift must ALSO be flagged, so the rollup can say the hit rate is untrustworthy"
  )
  assert(
    stats.cacheLookups === stats.cacheHits + stats.cacheMisses,
    "the reconciliation invariant must survive a buggy exit path"
  )
  assert(c.replies.length === 1, "an unsettled lookup must still be answered")
  console.log("  unsettled exit booked as miss and flagged: OK")
}

// ── 4. A hung handler is answered by the watchdog ───────────────────────────
{
  const { ns, stats } = makeHarness()
  const d = collect()
  const led = ns.createLookupLedger(d.sendResponse, 1, { url: "https://x/d.ts" })
  led.open()
  // ...and the handler never comes back. Drive the watchdog directly.
  const timer = setTimeout(() => {}, 0)
  clearTimeout(timer)

  setTimeout(() => {
    assert(
      stats.cacheLookupTimeouts === 1,
      `the watchdog must fire and be counted, got ${stats.cacheLookupTimeouts}`
    )
    assert(stats.cacheMisses === 1, "a timed-out lookup is a miss")
    assert(
      d.replies.length === 1 && d.replies[0].hit === false,
      "the player MUST be answered so it falls back to network instead of stalling"
    )
    assert(
      stats.cacheLookups === stats.cacheHits + stats.cacheMisses,
      "the invariant must hold across a timeout"
    )
    led.finalize()
    assert(
      stats.cacheMisses === 1 && d.replies.length === 1,
      "finalize after a watchdog must not double-count or double-answer"
    )
    console.log("  hung lookup answered by watchdog: OK")

    // ── 6. Exiting before open() is not counted ──────────────────────────────
    const { ns: ns2, stats: s2 } = makeHarness()
    const e = collect()
    const skipped = ns2.createLookupLedger(e.sendResponse, 1, { url: "https://x/e.ts" })
    skipped.respond({ ok: true, hit: false, skipped: true })
    skipped.finalize()
    assert(s2.cacheLookups === 0, "a lookup skipped before open() must not be counted")
    assert(s2.cacheMisses === 0 && s2.cacheLookupUnaccounted === 0, "nor booked as a miss")
    assert(e.replies.length === 1, "but it must still be answered")
    console.log("  pre-open exit not counted: OK")

    console.log("cache-lookup-ledger.test.js: OK")
  }, 5200)
}
