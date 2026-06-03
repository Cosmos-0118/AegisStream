/**
 * Run: node test/background/telemetry/seek-prediction-telemetry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const telemetryPath = path.join(
  __dirname,
  "../../../src/background/telemetry/seek-prediction-telemetry.js"
)

const logs = []
const sandbox = {
  self: {
    AegisBackground: {
      bumpActivity: () => {}
    }
  }
}
sandbox.self.AegisBackground.addLog = (_level, message) => {
  logs.push(message)
}
sandbox.globalThis = sandbox

vm.runInContext(fs.readFileSync(telemetryPath, "utf8"), vm.createContext(sandbox))

const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

api.resetSeekPredictionTelemetry()
api.recordSeekPrediction(1, {
  predictedIndex: 120,
  currentTimeSec: 1285,
  previousIndex: 33,
  teleport: true
})
const resolved = api.resolveSeekPredictionActual(1, 118, { source: "player-segment" })
assert(resolved?.error === 2, "absolute error computed")
const summary = api.getSeekPredictionSummary()
assert(summary.samples === 1, "one resolved sample")
assert(summary.meanError === 2, "mean error updated")
assert(summary.p95Error === 2, "p95 error updated")

api.resetSeekPredictionTelemetry()
api.recordSeekPrediction(2, { predictedIndex: 50, currentTimeSec: 200 })
api.resolveSeekPredictionActual(2, 51)
const summary2 = api.getSeekPredictionSummary()
assert(summary2.meanError === 1, "single-segment error")

console.log("seek-prediction-telemetry.test.js: all passed")
