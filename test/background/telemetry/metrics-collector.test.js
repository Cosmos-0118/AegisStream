/**
 * Run: node test/background/telemetry/metrics-collector.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const srcPath = path.join(
  __dirname,
  "../../../src/background/telemetry/metrics-collector.js"
)

const sandbox = { self: {} }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(srcPath, "utf8"), vm.createContext(sandbox))

const { metrics, recordStreamMetric, resetMetricsCollector } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

resetMetricsCollector()
recordStreamMetric("hls", "lookups", 1)
recordStreamMetric("hls", "hits", 1)
recordStreamMetric("hls", "hits", 1)
recordStreamMetric("hls", "misses", 1)
recordStreamMetric("ump", "lookups", 1)
recordStreamMetric("ump", "hits", 1)

const snap = metrics.getSnapshot()
assert(snap.hls.hits === 2, "hls hits tracked")
assert(snap.hls.misses === 1, "hls misses tracked")
assert(snap.ump.hits === 1, "ump hits tracked")
assert(snap.combined.hits === 3, "combined hits")
assert(snap.combined.hitRatePercent === 75, "combined hit rate")

resetMetricsCollector()
assert(metrics.getSnapshot().hls.hits === 0, "reset clears registry")

console.log("metrics-collector.test.js: all passed")
