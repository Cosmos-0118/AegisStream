/**
 * Run: node test/page/cache/hot-byte-cache.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mediaKeyPath = path.join(__dirname, "../../../src/page/media/media-cache-key-page.js")
const coalescerPath = path.join(
  __dirname,
  "../../../src/page/network/network-fetch-coalescer.js"
)
const hotCachePath = path.join(__dirname, "../../../src/page/cache/hot-byte-cache.js")

const sandbox = {
  globalThis: {},
  URL,
  Headers,
  ArrayBuffer,
  Uint8Array,
  TextEncoder,
  setTimeout,
  clearTimeout,
  location: { href: "https://cdn.example.com/watch" }
}
sandbox.self = sandbox.globalThis
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(coalescerPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(hotCachePath, "utf8"), ctx)

const ns = sandbox.globalThis.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeBytes(label) {
  return new TextEncoder().encode(label).buffer
}

async function run() {
  const urlA = "https://cdn.example.com/live/seg-10.ts?token=aaa"
  const urlB = "https://cdn.example.com/live/seg-10.ts?token=bbb"
  const urlOther = "https://cdn.example.com/live/seg-11.ts?token=ccc"

  assert(typeof ns.putHotBytes === "function", "putHotBytes should exist")
  assert(typeof ns.getHotBytes === "function", "getHotBytes should exist")

  const putOk = ns.putHotBytes(urlA, makeBytes("segment-10"), {
    contentType: "video/mp2t",
    status: 200
  })
  assert(putOk === true, "put should succeed")

  const hit = ns.getHotBytes(urlA)
  assert(hit?.ok === true && hit.hit === true, "exact URL should hit")
  assert(hit.contentType === "video/mp2t", "content type should round-trip")
  assert(hit.bytes.byteLength === makeBytes("segment-10").byteLength, "byte length should match")

  // Consumers get independent clones — mutating one must not poison the cache.
  new Uint8Array(hit.bytes)[0] = 0xff
  const hit2 = ns.getHotBytes(urlA)
  assert(
    new Uint8Array(hit2.bytes)[0] !== 0xff,
    "get must return a defensive clone"
  )

  const rotated = ns.getHotBytes(urlB)
  assert(
    rotated?.ok === true && rotated.bytes?.byteLength === hit.bytes.byteLength,
    "token-rotated URL with same path should hit via coalesce key"
  )

  assert(ns.hasHotBytes(urlA) === true, "hasHotBytes should be true")
  assert(ns.getHotBytes(urlOther) == null, "different segment should miss")

  ns.aliasHotBytes(urlOther, urlA)
  assert(ns.getHotBytes(urlOther)?.ok === true, "explicit alias should resolve")

  // Disabled serving must not put or get.
  ns.serveFromCache = false
  assert(ns.putHotBytes(urlA, makeBytes("blocked")) === false, "put blocked when serve disabled")
  assert(ns.getHotBytes(urlA) == null, "get blocked when serve disabled")
  ns.serveFromCache = true
  assert(ns.getHotBytes(urlA)?.ok === true, "get restored when serve enabled")

  ns.extensionEnabled = false
  assert(ns.getHotBytes(urlA) == null, "get blocked when extension disabled")
  ns.extensionEnabled = true

  // Oversized entry rejected.
  const huge = new ArrayBuffer(17 * 1024 * 1024)
  assert(
    ns.putHotBytes("https://cdn.example.com/live/huge.ts", huge) === false,
    "oversized entry should be rejected"
  )

  let woke = null
  const waitPromise = ns.awaitHotBytes("https://cdn.example.com/live/seg-12.ts", null, {
    timeoutMs: 500
  })
  setTimeout(() => {
    ns.putHotBytes("https://cdn.example.com/live/seg-12.ts", makeBytes("segment-12"), {
      contentType: "video/mp2t"
    })
  }, 20)

  woke = await waitPromise
  assert(woke?.ok === true && woke.via === "hot-l1", "awaitHotBytes should wake on put")

  // Waiter timeout must resolve null, not hang.
  const timedOut = await ns.awaitHotBytes(
    "https://cdn.example.com/live/never-arrives.ts",
    null,
    { timeoutMs: 40 }
  )
  assert(timedOut == null, "awaitHotBytes should time out")

  ns.clearHotByteCache("test")
  assert(ns.getHotBytes(urlA) == null, "clear should empty cache")
  assert(ns.getHotByteCacheStats().entries === 0, "stats should show empty")

  // LRU eviction: fill beyond MAX_ENTRIES (128)
  for (let i = 0; i < 140; i += 1) {
    ns.putHotBytes(`https://cdn.example.com/live/seg-evict-${i}.ts`, makeBytes(`e${i}`), {
      contentType: "video/mp2t"
    })
  }
  const stats = ns.getHotByteCacheStats()
  assert(stats.entries <= 128, `entries should be capped (got ${stats.entries})`)
  assert(ns.getHotBytes("https://cdn.example.com/live/seg-evict-0.ts") == null, "oldest should be evicted")
  assert(
    ns.getHotBytes("https://cdn.example.com/live/seg-evict-139.ts")?.ok === true,
    "newest should remain"
  )

  console.log("hot-byte-cache.test.js: ok")
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
