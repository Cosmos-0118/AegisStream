/**
 * Run: node test/background/prefetch/stream-arbitrator.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const rescuePath = path.join(__dirname, "../../../src/background/prefetch/rescue-lane.js")
const arbPath = path.join(__dirname, "../../../src/background/prefetch/stream-arbitrator.js")

const sandbox = {
  self: {
    AegisBackground: {
      state: { playlistByTab: new Map() },
      constants: {
        SCRUB_DELEGATE_MIN_INTERVAL_MS: 280,
        SCHEDULER_ARBITRATE_MIN_MS: 200,
        RESCUE_SCHEDULE_MIN_MS: 400,
        RESCUE_ENTER_RUNWAY_SEC: 3,
        RESCUE_EXIT_RUNWAY_SEC: 5,
        RESCUE_ENTER_HEALTH_PCT: 5,
        RESCUE_EXIT_HEALTH_PCT: 15
      },
      EngineModes: {
        NORMAL: "NORMAL",
        AGGRESSIVE: "AGGRESSIVE",
        RESCUE: "RESCUE"
      },
      addLog: () => {},
      applyEngineMode: (tabState, mode) => {
        tabState.activeEngineMode = mode
        return mode
      },
      isRescueModeActive: (tabState) =>
        tabState?.activeEngineMode === "RESCUE" || tabState?.rescueLaneLatched === true
    }
  }
}
sandbox.globalThis = sandbox
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(rescuePath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(arbPath, "utf8"), ctx)

const { arbitratePrefetchSchedule, prefetchSourcePriority } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(prefetchSourcePriority("scrub-velocity-prewarm") > prefetchSourcePriority("chunk-observed"), "velocity beats chunk")

const tab = {
  bufferRunwaySec: 0,
  bufferHealthScore: 0,
  bufferTier: "emergency",
  segments: ["a", "b", "c"],
  anchorIndex: 1
}
sandbox.self.AegisBackground.evaluateStreamingUrgency(tab)
const rescueDecision = arbitratePrefetchSchedule(1, tab, "buffer-emergency", {})
assert(rescueDecision.allow === true, "rescue source allowed in rescue mode")
assert(rescueDecision.mode === "RESCUE", "mode is rescue")

const blocked = arbitratePrefetchSchedule(1, tab, "chunk-observed", {})
assert(blocked.allow === false, "chunk-observed blocked during rescue")
assert(blocked.reason === "rescue-active", "blocked with rescue-active reason")

tab.lastArbitratedPrefetchAt = Date.now()
tab.lastArbitratedPrefetchPriority = prefetchSourcePriority("scrub-velocity-prewarm")
const superseded = arbitratePrefetchSchedule(1, tab, "chunk-observed", { force: true })
assert(superseded.allow === false, "lower priority superseded during churn window")

console.log("stream-arbitrator.test.js: OK")
