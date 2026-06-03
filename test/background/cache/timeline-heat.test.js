/**
 * Run: node test/background/cache/timeline-heat.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const heatPath = path.join(__dirname, "../../../src/background/cache/timeline-heat.js")

const sandbox = {
  self: {
    state: { playlistByTab: new Map() }
  },
  URL
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
sandbox.self.AegisBackground.state = sandbox.self.state
sandbox.self.resolveSegmentIndexInManifest = (url, tabState) => {
  const idx = tabState.segments.indexOf(url)
  return idx >= 0 ? idx : null
}
sandbox.self.AegisBackground.resolveSegmentIndexInManifest =
  sandbox.self.resolveSegmentIndexInManifest
vm.runInContext(fs.readFileSync(heatPath, "utf8"), vm.createContext(sandbox))

const {
  recordTimelineHeat,
  getTimelineHeatForIndex,
  computeTimelineSurvivalScore,
  isTimelineHeatProtected
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const tabId = 1
const tabState = {
  segments: ["https://cdn.example/s0", "https://cdn.example/s80"],
  anchorIndex: 80,
  timelineHeat: new Map()
}
sandbox.self.state.playlistByTab.set(tabId, tabState)

recordTimelineHeat(tabId, 80, 3)
recordTimelineHeat(tabId, 80, 3)
assert(getTimelineHeatForIndex(tabState, 80) === 6, "heat accumulates per segment index")

const coldDistance = 80 + 1000
const coldSurvival = computeTimelineSurvivalScore(coldDistance, 0)
const hotSurvival = computeTimelineSurvivalScore(5, 6)
assert(!isTimelineHeatProtected(coldSurvival, 0), "cold intro should not be heat-protected")
assert(isTimelineHeatProtected(hotSurvival, 6), "rewatch band should be heat-protected")

console.log("timeline-heat.test.js: all assertions passed")
