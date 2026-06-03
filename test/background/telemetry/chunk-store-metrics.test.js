/**
 * Run: node test/background/telemetry/chunk-store-metrics.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const root = path.join(__dirname, "../../..")

function loadScript(relativePath) {
  vm.runInContext(
    fs.readFileSync(path.join(root, relativePath), "utf8"),
    vm.createContext(sandbox)
  )
}

const sandbox = {
  self: {},
  console,
  Date,
  Math,
  Set,
  Map,
  Array,
  Object,
  Number,
  String
}
sandbox.self = sandbox

loadScript("src/background/config/constants.js")
loadScript("src/background/state/runtime-state.js")
loadScript("src/background/telemetry/runtime-metrics.js")

const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

api.handleRuntimeMetric(
  { metricType: "chunk_store_outcome", captureSource: "xhr-sync", ok: true, byteLength: 2048 },
  {}
)
api.handleRuntimeMetric(
  { metricType: "chunk_store_outcome", captureSource: "xhr-sync", ok: true, byteLength: 4096 },
  {}
)
api.handleRuntimeMetric(
  { metricType: "chunk_store_outcome", captureSource: "fetch-clone", ok: false, byteLength: 0 },
  {}
)

const line = api.formatChunkStoreTelemetryLine()
assert(line.includes("ok=2"), `expected 2 successes, got: ${line}`)
assert(line.includes("fail=1"), `expected 1 failure, got: ${line}`)
assert(line.includes("avgKB=3.0"), `expected avgKB=3.0, got: ${line}`)
assert(line.includes("xhr-sync=2"), `expected xhr-sync breakdown, got: ${line}`)
assert(
  api.state.telemetry.chunkStore.bySource["fetch-clone"].failed === 1,
  "fetch-clone failure should be tracked per source"
)

console.log("chunk-store-metrics.test.js: all assertions passed")
