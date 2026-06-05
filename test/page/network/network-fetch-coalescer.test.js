/**
 * Run: node test/page/network/network-fetch-coalescer.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const coalescerPath = path.join(
  __dirname,
  "../../../src/page/network/network-fetch-coalescer.js"
)
const keyPath = path.join(
  __dirname,
  "../../../src/page/media/media-cache-key-page.js"
)

const sandbox = { globalThis: {}, URL, ArrayBuffer, Uint8Array, setTimeout, clearTimeout }
sandbox.self = sandbox.globalThis
vm.runInContext(fs.readFileSync(keyPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(coalescerPath, "utf8"), vm.createContext(sandbox))

const ns = sandbox.globalThis.AegisPageBridge
ns.networkFirstByteP95Ms = 900
const {
  beginCoalescedNetworkFetch,
  joinCoalescedNetworkFetch,
  joinActivePageWire,
  hasActivePageWire,
  isNetworkFetchInflight,
  resolveCollapseWaitTimeoutMs
} = ns

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(resolveCollapseWaitTimeoutMs() === 1800, "collapse wait should be 2x p95 clamped to min 1500")

;(async () => {
  let factoryCalls = 0
  const key = "aegis|hls|cdn.example.com|live/seg.ts"
  const leader = beginCoalescedNetworkFetch(key, async () => {
    factoryCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { ok: true, bytes: new Uint8Array([1, 2, 3]).buffer }
  })

  assert(isNetworkFetchInflight(key), "coalesced fetch should be inflight")
  const follower = joinCoalescedNetworkFetch(key)
  const [a, b] = await Promise.all([leader, follower])
  assert(factoryCalls === 1, "factory should run once for concurrent joiners")
  assert(a?.ok && b?.ok, "both joiners should receive ok result")
  assert(a.bytes.byteLength === 3, "bytes should be preserved")

  const wireKey = "aegis|hls|cdn.example.com|wire/seg.ts"
  beginCoalescedNetworkFetch(wireKey, async () => ({
    ok: true,
    bytes: new Uint8Array([9]).buffer,
    contentType: "video/mp2t"
  }))
  assert(hasActivePageWire(wireKey), "hasActivePageWire should see inflight entry")
  const wireJoin = await joinActivePageWire(wireKey)
  assert(wireJoin?.ok && wireJoin.bytes?.byteLength === 1, "joinActivePageWire should return bytes")
  assert(wireJoin.via === "page-wire", "local wire join should tag page-wire path")

  console.log("network-fetch-coalescer.test.js: all assertions passed")
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
