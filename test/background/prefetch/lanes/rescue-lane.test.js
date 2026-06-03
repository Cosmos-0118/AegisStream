/**
 * Run: node test/background/prefetch/rescue-lane.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const rescuePath = path.join(__dirname, "../../../src/background/prefetch/rescue-lane.js")

const sandbox = {
  self: {
    AegisBackground: {
      state: { playlistByTab: new Map() },
      constants: {
        RESCUE_ENTER_RUNWAY_SEC: 3,
        RESCUE_EXIT_RUNWAY_SEC: 5,
        RESCUE_ENTER_HEALTH_PCT: 5,
        RESCUE_EXIT_HEALTH_PCT: 15,
        RESCUE_SEGMENTS_AHEAD: 2
      },
      addLog: () => {},
      EngineModes: {
        NORMAL: "NORMAL",
        AGGRESSIVE: "AGGRESSIVE",
        RESCUE: "RESCUE"
      }
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(rescuePath, "utf8"), vm.createContext(sandbox))

const { evaluateStreamingUrgency, EngineModes } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const tab = { bufferRunwaySec: 1, bufferHealthScore: 80 }
assert(evaluateStreamingUrgency(tab) === EngineModes.RESCUE, "low runway triggers rescue")
assert(tab.rescueLaneLatched === true, "rescue latch set")
assert(
  evaluateStreamingUrgency({ bufferRunwaySec: 30, bufferHealthScore: 2 }) === EngineModes.RESCUE,
  "low health triggers rescue"
)
assert(
  evaluateStreamingUrgency({ ...tab, bufferRunwaySec: 4, bufferHealthScore: 10 }) === EngineModes.RESCUE,
  "hysteresis keeps rescue until exit thresholds"
)
assert(
  evaluateStreamingUrgency({ ...tab, bufferRunwaySec: 6, bufferHealthScore: 20 }) !== EngineModes.RESCUE,
  "hysteresis exits rescue when runway and health recover"
)
assert(
  evaluateStreamingUrgency({ bufferRunwaySec: 30, bufferHealthScore: 90, scrubbingTrainUntil: Date.now() + 5000 }) ===
    EngineModes.AGGRESSIVE,
  "scrub train is aggressive"
)

console.log("rescue-lane.test.js: all assertions passed")
