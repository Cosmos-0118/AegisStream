/**
 * Regression: no await against IndexedDB may hang forever.
 *
 * Field failure: a cache lookup logged its "resolveCachedChunk start" line and
 * then produced nothing further — no hit, no miss, no response. The player waited,
 * gave up, and fetched the segment from the network itself. Across one session
 * 49 of 65 lookups ended that way (`lookups=65 hits=16 misses=0`).
 *
 * IndexedDB has two silent ways to never call back, and this layer had both:
 *   - `indexedDB.open()` fires `blocked` — NOT onsuccess and NOT onerror —
 *     whenever another connection still holds the database. openDb() listened
 *     for the two that never arrive.
 *   - a transaction can `abort` without its request ever firing onerror.
 * Compounding it, db.close() sat after the await, so any rejection leaked the
 * connection — and a leaked connection is exactly what makes the next open block.
 *
 * Contract:
 *  1. A blocked open rejects instead of hanging.
 *  2. A request that never calls back times out instead of hanging.
 *  3. resolveCachedChunk survives both by returning null, so the caller reaches
 *     its miss accounting rather than stalling.
 *  4. The connection is closed even when the operation fails.
 *
 * Run: node test/background/cache/idb-bounded-await.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const R = path.join(__dirname, "../../..")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness(mode) {
  const closed = []
  const fakeDb = {
    objectStoreNames: { contains: () => true },
    transaction() {
      return {
        objectStore: () => ({
          // mode "silent-request": the request never calls back at all.
          get: () => ({ onsuccess: null, onerror: null })
        })
      }
    },
    close: () => closed.push(1)
  }

  const indexedDB = {
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: fakeDb }
      setTimeout(() => {
        // mode "blocked": only the blocked event ever fires — the exact shape
        // that used to leave the promise pending forever.
        if (mode === "blocked") req.onblocked?.()
        else req.onsuccess?.()
      }, 0)
      return req
    }
  }

  const sandbox = {
    console, Date, Math, Number, String, Object, Map, Set, Array, JSON, Promise,
    setTimeout, clearTimeout, URL, indexedDB
  }
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/config/constants.js"), "utf8"), ctx)
  const ns = sandbox.self.AegisBackground
  ns.state = { stats: ns.constants.createInitialStats(), settings: { serveFromCache: true }, cachePolicy: null }
  ns.addLog = () => {}
  ns.stripHash = (u) => String(u).split("#")[0]
  ns.buildCacheKeyVariants = (u) => [u]
  vm.runInContext(fs.readFileSync(path.join(R, "src/shared/media-cache-key.js"), "utf8"), ctx)
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/cache/db.js"), "utf8"), ctx)
  return { ns, closed }
}

/** Rejects if the promise has not settled in time — a hang fails the test. */
function mustSettle(promise, ms, what) {
  return Promise.race([
    promise.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: e })),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`HUNG: ${what} never settled`)), ms))
  ])
}

const URL_UNDER_TEST = "https://cdn.example.com/media/0042.ts"

;(async () => {
  // ── 1 & 3. A blocked open must not hang, and must surface as a clean miss ──
  {
    const { ns, closed } = makeHarness("blocked")
    const res = await mustSettle(ns.resolveCachedChunk(URL_UNDER_TEST), 8000, "resolveCachedChunk (blocked open)")
    assert(res.ok === true, `resolveCachedChunk must swallow a blocked open, got ${res.error && res.error.message}`)
    assert(
      res.value === null,
      "a blocked open must resolve to null so the caller records a miss — never leave the lookup pending"
    )
    assert(closed.length === 0, "a connection that never opened must not be closed")
    console.log("  blocked open resolves null instead of hanging: OK")
  }

  // ── 2, 3 & 4. A request that never calls back must time out ───────────────
  {
    const { ns, closed } = makeHarness("silent-request")
    const started = Date.now()
    const res = await mustSettle(ns.resolveCachedChunk(URL_UNDER_TEST), 12000, "resolveCachedChunk (silent request)")
    assert(res.ok === true, `resolveCachedChunk must swallow a request timeout, got ${res.error && res.error.message}`)
    assert(res.value === null, "a silent IndexedDB request must resolve to null, not hang the lookup")
    assert(
      Date.now() - started < 10000,
      "the timeout must be bounded well inside the player's patience"
    )
    assert(
      closed.length > 0,
      "the connection MUST be closed even when the operation fails — a leaked connection is what blocks the next open"
    )
    console.log("  silent request times out and closes the connection: OK")
  }

  console.log("idb-bounded-await.test.js: OK")
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
