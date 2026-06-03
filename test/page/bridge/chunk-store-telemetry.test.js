/**
 * Run: node test/page/bridge/chunk-store-telemetry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const corePath = path.join(__dirname, "../../../src/page/bridge/core.js")

const metrics = []
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
sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms)
sandbox.clearTimeout = clearTimeout
sandbox.window = {
  fetch: () => Promise.resolve({ ok: false }),
  postMessage: (payload) => {
    if (payload?.type === "RUNTIME_METRIC" && payload.metricType === "chunk_store_outcome") {
      metrics.push(payload)
    }
    if (payload?.type === "DEBUG_LOG") {
      sandbox.debugLogs = sandbox.debugLogs || []
      sandbox.debugLogs.push(payload)
    }
  }
}
sandbox.window.fetch.bind = () => () => Promise.resolve({ ok: false })
sandbox.chrome = { runtime: { sendMessage: () => {} } }
vm.runInContext(fs.readFileSync(corePath, "utf8"), vm.createContext(sandbox))

const bridge = sandbox.globalThis.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(bridge.normalizeCaptureSource("XHR-SYNC") === "xhr-sync", "normalize known source")
assert(bridge.normalizeCaptureSource("nope") === "unknown", "normalize unknown source")

;(async () => {
  await bridge.storeChunkFromPage({
    url: "https://example.com/empty.ts",
    bytes: new ArrayBuffer(0),
    status: 200,
    method: "GET",
    hasRange: false,
    captureSource: "xhr-sync"
  })

  assert(
    sandbox.debugLogs?.some((entry) => String(entry.msg).includes("zero-byte-chunk")),
    "zero-byte chunk should warn"
  )
  assert(metrics.length === 1, "zero-byte store should emit one outcome metric")
  assert(metrics[0].ok === false, "zero-byte store should count as failed")
  assert(metrics[0].captureSource === "xhr-sync", "metric should preserve capture source")

  console.log("chunk-store-telemetry.test.js: all assertions passed")
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
