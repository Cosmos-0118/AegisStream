/**
 * Regression: a first-pass cache miss must reach the segment-history recovery
 * path, not throw.
 *
 * Field failure (10.7-minute session, 06:31–06:42): every one of 22 logged
 * lookups ended in `Cache lookup threw: buildCacheKeyVariants is not defined`.
 * message-router.js called the function bare but never added it to its
 * `const { ... } = ns` block; the name only exists as ns.buildCacheKeyVariants,
 * module-local to cache-keys.js. Introduced in 4be415b and live for 17 commits.
 *
 * It hid because of *where* it sits: resolveCachedChunkWithSegmentHistory
 * returns early when the first IndexedDB pass hits, so the ReferenceError fires
 * only on a miss — and the lookup handler's catch turned it into an ordinary
 * `{ok:false, hit:false}`. Every rollup in that session showed miss ==
 * UNACCOUNTED exactly: there were no real misses at all, only crashes wearing a
 * miss's clothes.
 *
 * The cost was not just the metric. The throw aborts the handler before the
 * bridge wait, the inflight-prefetch collapse, the inflight-write collapse and
 * ensureTabPlaylistRecovery — so a segment already in flight, milliseconds from
 * being servable, was reported to the player as a hard failure and refetched
 * from network. That is the "low hit rate" symptom, not a caching problem.
 *
 * Contract:
 *  1. A first-pass miss resolves rather than throwing.
 *  2. Its candidate set includes the cache-key variants of the requested URL.
 *  3. It includes prior signed URLs for the SAME manifest index, and no others —
 *     serving segment N±1's bytes for segment N corrupts playback.
 *  4. A hit stored under a rotated URL for that index is actually recovered.
 *
 * Run: node test/background/messaging/lookup-miss-recovery.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const R = path.join(__dirname, "../../..")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness(store) {
  const sandbox = {
    console, Date, Math, Number, String, Object, Map, Set, Array, JSON, Promise,
    setTimeout, clearTimeout, URL, TextEncoder, TextDecoder
  }
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)

  // Real constants and real cache-key derivation — the variants under test.
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/config/constants.js"), "utf8"), ctx)
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/media/cache-keys.js"), "utf8"), ctx)
  const ns = sandbox.self.AegisBackground
  ns.state = { stats: ns.constants.createInitialStats(), settings: {}, playlistByTab: new Map() }

  const attempted = []
  ns.resolveCachedChunk = async (url) => {
    attempted.push(url)
    return store.has(url) ? { item: store.get(url), key: url } : null
  }
  ns.bumpActivity = () => {}

  // The three resolver functions verbatim out of message-router.
  const src = fs.readFileSync(path.join(R, "src/background/messaging/message-router.js"), "utf8")
  const start = src.indexOf("async function resolveCachedChunkWithCandidates")
  const end = src.indexOf("async function bridgeStoredChunkRotationAliases")
  assert(start > 0 && end > start, "could not extract the resolver span from message-router.js")

  // Bound exactly the way message-router binds them: destructured from ns at
  // module scope. If a name is missing from that list here, it is missing there.
  const destructured = src.slice(src.indexOf("const {"), src.indexOf("} = ns") + 6)

  vm.runInContext(
    `(() => { const ns = self.AegisBackground;
      ${destructured}
      ${src.slice(start, end)}
      ns.__buildCacheLookupCandidates = buildCacheLookupCandidates;
      ns.__resolveWithSegmentHistory = resolveCachedChunkWithSegmentHistory })()`,
    ctx
  )
  return { ns, attempted }
}

const URL_N = "https://cdn.example/anime/abc/seg-f1-00275.png?mod=1&x-signature=NEW"
const URL_N_OLD = "https://cdn.example/anime/abc/seg-f1-00275.png?mod=1&x-signature=OLD"
const URL_NEIGHBOUR = "https://cdn.example/anime/abc/seg-f1-00276.png?mod=1&x-signature=OLD"

function tabStateWithHistory() {
  return {
    segments: [URL_N],
    segmentUrlHistory: new Map([
      [275, [URL_N_OLD]],
      [276, [URL_NEIGHBOUR]]
    ])
  }
}

// ── 1 & 2. A first-pass miss resolves, and tries the key variants ───────────
{
  const store = new Map()
  const { ns, attempted } = makeHarness(store)
  ns.state.playlistByTab.set(7, tabStateWithHistory())
  ;(async () => {
    const result = await ns.__resolveWithSegmentHistory(URL_N, 7, 275, null)
    assert(result === null || !result.item, "nothing is stored, so this must resolve to a miss")
    assert(
      attempted.length > 1,
      `a miss MUST fall through to the candidate set; only the first pass ran (${attempted.length} attempt)`
    )
    console.log(`  first-pass miss reaches recovery (${attempted.length} candidates tried): OK`)

    // ── 3. Same-index history only ─────────────────────────────────────────
    const candidates = ns.__buildCacheLookupCandidates(URL_N, tabStateWithHistory(), 275)
    assert(candidates.includes(URL_N), "the requested URL must be a candidate")
    assert(
      candidates.includes(URL_N_OLD),
      "a prior signed URL for the SAME manifest index must be a candidate"
    )
    assert(
      !candidates.includes(URL_NEIGHBOUR),
      "a neighbouring segment's URL must NEVER be a candidate — it would serve the wrong bytes"
    )
    console.log("  candidate set is same-index only: OK")

    // ── 4. A rotated-URL hit is actually recovered ─────────────────────────
    const store2 = new Map([[URL_N_OLD, { bytes: new ArrayBuffer(1024), contentType: "video/mp2t" }]])
    const h2 = makeHarness(store2)
    h2.ns.state.playlistByTab.set(7, tabStateWithHistory())
    const recovered = await h2.ns.__resolveWithSegmentHistory(URL_N, 7, 275, null)
    assert(recovered?.item, "bytes stored under the previous signed URL for this index must be served")
    assert(
      recovered.item.bytes.byteLength === 1024,
      "the recovered entry must carry the stored bytes"
    )
    console.log("  rotated-URL hit recovered: OK")

    console.log("lookup-miss-recovery.test.js: OK")
  })().catch((e) => {
    console.error(`FAILED: ${e.name}: ${e.message}`)
    process.exit(1)
  })
}
