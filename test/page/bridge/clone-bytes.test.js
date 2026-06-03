/**
 * Run: node test/page/bridge/clone-bytes.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const corePath = path.join(__dirname, "../../../src/page/bridge/core.js")

const sandbox = { globalThis: {}, URL, ArrayBuffer, Uint8Array, TextEncoder, performance: { now: () => 0 } }
sandbox.self = sandbox.globalThis
sandbox.window = { fetch: () => Promise.resolve({ ok: false }) }
sandbox.window.fetch.bind = () => () => Promise.resolve({ ok: false })
sandbox.chrome = { runtime: { sendMessage: () => {} } }
sandbox.setTimeout = () => 0
vm.runInContext(fs.readFileSync(corePath, "utf8"), vm.createContext(sandbox))

const bridge = sandbox.globalThis.AegisPageBridge
const { cloneBytesForBridge, requestRuntime } = bridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const original = new Uint8Array([1, 2, 3, 4]).buffer
const copy = cloneBytesForBridge(original)
assert(copy && copy.byteLength === 4, "clone should preserve length")

let postMessageTransfer = undefined
let storeOutboundBytes = null
sandbox.window.postMessage = (payload, _target, transfer) => {
  postMessageTransfer = transfer
  if (payload?.type === "STORE_CHUNK_REQUEST") {
    storeOutboundBytes = payload.bytes
  }
}

const pending = sandbox.globalThis.AegisPageBridge.pending
pending.set("noop", () => {})

requestRuntime("STORE_CHUNK_REQUEST", { url: "https://example.com/a.ts", bytes: original })
assert(Array.isArray(postMessageTransfer) && postMessageTransfer.length === 0, "store must not transfer")
assert(original.byteLength === 4, "source buffer must stay attached after store request")
assert(storeOutboundBytes instanceof Uint8Array, "store lane must send Uint8Array for extension IPC")
assert(storeOutboundBytes.byteLength === 4, "transport view must preserve byte length")

console.log("clone-bytes.test.js: all assertions passed")
