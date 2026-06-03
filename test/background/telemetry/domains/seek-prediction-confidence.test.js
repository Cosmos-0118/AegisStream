/**
 * Run: node test/background/telemetry/domains/seek-prediction-confidence.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const telemetryPath = path.join(
  __dirname,
  "../../../../src/background/telemetry/domains/seek-prediction-telemetry.js"
)

const sandbox = {
  self: {
    AegisBackground: {
      addLog: () => {},
      bumpActivity: () => {}
    },
    constants: {
      SEEK_PREDICTION_MIN_SAMPLES: 4,
      SEEK_PREDICTION_DISABLE_THRESHOLD: 0.35,
      SEEK_PREDICTION_SPECULATIVE_THRESHOLD: 0.75,
      SEEK_PREDICTION_OUTLIER_LAMBDA: 0.02
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(telemetryPath, "utf8"), vm.createContext(sandbox))

const {
  recordSeekPrediction,
  resolveSeekPredictionActual,
  resetSeekPredictionTelemetry,
  isSeekPredictionEnabled,
  isSpeculativePredictionEnabled,
  getPredictionConfidence
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(isSeekPredictionEnabled() === true, "neutral confidence should keep predictor on")

for (let i = 0; i < 8; i += 1) {
  sandbox.self.AegisBackground.recordSeekPrediction(1, {
    predictedIndex: 0,
    currentTimeSec: i,
    previousIndex: null
  })
  resolveSeekPredictionActual(1, 100, { source: "test" })
}
assert(getPredictionConfidence() < 0.35, "outlier misses should crush penalized confidence")
assert(isSeekPredictionEnabled() === false, "predictor should disable when confidence low")

resetSeekPredictionTelemetry()
for (let i = 0; i < 8; i += 1) {
  recordSeekPrediction(2, { predictedIndex: 50, currentTimeSec: i, previousIndex: 49 })
  resolveSeekPredictionActual(2, 50, { source: "test" })
}
assert(isSpeculativePredictionEnabled() === true, "accurate predictor enables speculation")

console.log("seek-prediction-confidence.test.js: all assertions passed")
