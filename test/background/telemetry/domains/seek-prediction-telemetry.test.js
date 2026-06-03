/**
 * Run: node test/background/telemetry/domains/seek-prediction-telemetry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const telemetryPath = path.join(
  __dirname,
  "../../../../src/background/telemetry/domains/seek-prediction-telemetry.js"
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
const near = api.resolveSeekPredictionActual(2, 51)
assert(near?.accuracyScore > 0.7, "gaussian rewards near-miss")
const summary2 = api.getSeekPredictionSummary()
assert(summary2.meanError === 1, "single-segment error")

api.resetSeekPredictionTelemetry()
api.recordSeekPrediction(3, { predictedIndex: 10, currentTimeSec: 40 })
api.notePlayerPausedForSeekPrediction(3)
assert(api.resolveSeekPredictionActual(3, 10) === null, "paused pending evicted without scoring")
assert(api.getSeekPredictionSummary().samples === 0, "pause eviction leaves no resolved samples")

api.resetSeekPredictionTelemetry()
api.recordSeekPrediction(4, { predictedIndex: 50, currentTimeSec: 200 })
assert(api.getSeekPredictionSummary().pending === 1, "macro prediction pending")
api.recordSeekPrediction(4, {
  predictedIndex: 51,
  currentTimeSec: 201,
  source: "seek-prediction-scrub-observe"
})
assert(api.getSeekPredictionSummary().pending === 1, "scrub observe must not add pending")

api.resetSeekPredictionTelemetry()
api.recordSeekPrediction(5, { predictedIndex: 20, currentTimeSec: 10 })
api.invalidateSeekPredictionsForScrub(5)
assert(api.resolveSeekPredictionActual(5, 20) === null, "scrub invalidates ghost pending")

console.log("seek-prediction-telemetry.test.js: all passed")
