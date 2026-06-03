/**
 * Run: node test/page/bridge/chunk-store-guard.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const corePath = path.join(__dirname, "../../../src/page/bridge/core.js")

const sandbox = {
  globalThis: {},
  URL,
  ArrayBuffer,
  Uint8Array,
  TextEncoder,
  AbortController,
  DOMException,
  performance: { now: () => 0 }
}
sandbox.self = sandbox.globalThis
sandbox.setTimeout = (fn, ms) => {
  const id = setTimeout(fn, ms)
  return id
}
sandbox.clearTimeout = clearTimeout
sandbox.window = {
  fetch: () => Promise.resolve({ ok: false }),
  postMessage: () => {}
}
sandbox.window.fetch.bind = () => () => Promise.resolve({ ok: false })
sandbox.chrome = { runtime: { sendMessage: () => {} } }
vm.runInContext(fs.readFileSync(corePath, "utf8"), vm.createContext(sandbox))

const bridge = sandbox.globalThis.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

let storePostCount = 0
sandbox.window.postMessage = (payload) => {
  if (payload?.type === "STORE_CHUNK_REQUEST") storePostCount += 1
}

const bytes = new Uint8Array([9, 8, 7]).buffer
;(async () => {
  const storePromise = bridge.storeChunkFromPage({
    url: "https://example.com/seg.ts",
    bytes,
    status: 200,
    method: "GET",
    hasRange: false
  })
  await Promise.resolve()

  assert(storePostCount >= 1, "store should reach bridge")

  const evicted = bridge.cancelInflightChunkStores("test-teardown")
  assert(evicted >= 1, "cancel should evict at least one in-flight store")

  const result = await storePromise
  assert(result?.aborted === true, "cancelled store should return aborted result")
  assert(storePostCount === 1, "cancelled store should not retry bridge after eviction")

  console.log("chunk-store-guard.test.js: all assertions passed")
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
