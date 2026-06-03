/**
 * Run: node test/background/telemetry/episode-transition-telemetry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const srcPath = path.join(
  __dirname,
  "../../../src/background/telemetry/episode-transition-telemetry.js"
)

const logs = []
const sandbox = {
  self: {
    AegisBackground: {
      addLog: (_level, message) => logs.push(message)
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(srcPath, "utf8"), vm.createContext(sandbox))

const {
  recordEpisodeTransitionSwitch,
  recordManifestRefreshStart,
  recordManifestRefreshComplete,
  recordFirstSuccessfulSegment,
  recordPlaybackResumedAfterStall
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

recordEpisodeTransitionSwitch(1)
recordManifestRefreshStart(1)
recordManifestRefreshComplete(1)
recordFirstSuccessfulSegment(1)
recordPlaybackResumedAfterStall(1)

const timingLog = logs.filter((line) => line.startsWith("Episode transition timing")).pop()
assert(timingLog, "expected consolidated timing log")
assert(
  /switch→refreshStart=|switch→refreshDone=|switch→firstChunk=|switch→playback=/.test(timingLog),
  `timing log missing deltas: ${timingLog}`
)

console.log("episode-transition-telemetry.test.js: OK")
