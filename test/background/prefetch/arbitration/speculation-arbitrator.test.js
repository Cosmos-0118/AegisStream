/**
 * Run: node test/background/prefetch/arbitration/speculation-arbitrator.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const arbitratorPath = path.join(
  __dirname,
  "../../../../src/background/prefetch/arbitration/speculation-arbitrator.js"
)

const sandbox = {
  self: {
    AegisBackground: {
      constants: {
        SPECULATIVE_TARGET_RUNWAY_SEC: 30,
        SPECULATIVE_CONTINUOUS_THRESHOLD: 0.35,
        SPECULATIVE_CONTINUOUS_AGGRESSIVE_THRESHOLD: 0.7,
        SPECULATIVE_CONTINUOUS_RUNWAY_FLOOR_SEC: 5,
        SPECULATIVE_CONGESTED_MULTIPLIER: 0.3,
        SPECULATIVE_NOMINAL_BLOCKED_MULTIPLIER: 0.5
      },
      getPredictionConfidence: () => 0.5
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(arbitratorPath, "utf8"), vm.createContext(sandbox))

const { calculateContinuousSpeculationPriority } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const richRunway = calculateContinuousSpeculationPriority(
  { confidence: 0.5 },
  { runwaySec: 45, activeTierName: "NOMINAL", speculativeAllowed: true }
)
assert(richRunway.allowSpeculation === true, "50% conf + 45s runway should allow speculation")
assert(richRunway.priorityTier === "CONSERVATIVE_LQ", "moderate score uses conservative tier")

const poor = calculateContinuousSpeculationPriority(
  { confidence: 0.5 },
  { runwaySec: 3, activeTierName: "NOMINAL" }
)
assert(poor.allowSpeculation === false, "low runway blocks speculation")

const legacyCliff = calculateContinuousSpeculationPriority(
  { confidence: 0.5 },
  { runwaySec: 8, activeTierName: "NOMINAL", speculativeAllowed: true }
)
assert(legacyCliff.score < 0.35, "short runway keeps score below threshold at 50% conf")

console.log("speculation-arbitrator.test.js: all passed")
