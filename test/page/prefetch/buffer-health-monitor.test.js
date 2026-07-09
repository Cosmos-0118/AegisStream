/**
 * Run: node test/page/prefetch/buffer-health-monitor.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const srcPath = path.join(__dirname, "../../../src/page/prefetch/buffer-health-monitor.js")

const sandbox = {
  self: {},
  document: {
    readyState: "complete",
    visibilityState: "visible",
    querySelectorAll: () => [],
    documentElement: null,
    addEventListener: () => {}
  },
  location: { href: "https://example.com" },
  setInterval: () => 0,
  setTimeout: (fn) => {
    fn()
    return 0
  },
  clearTimeout: () => {},
  MutationObserver: class {
    observe() {}
  }
}
sandbox.self.AegisPageBridge = {
  claimExecutionSlot: () => true,
  notifyRuntime: () => {},
  logBridge: () => {}
}
sandbox.globalThis = sandbox

vm.runInContext(fs.readFileSync(srcPath, "utf8"), vm.createContext(sandbox))

const {
  runwayAtPlayhead,
  computeHealthScore,
  classifyTier,
  bumpSeekActivity
} = sandbox.self.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function mockVideo(currentTime, ranges) {
  return {
    currentTime,
    buffered: {
      length: ranges.length,
      start: (i) => ranges[i][0],
      end: (i) => ranges[i][1]
    }
  }
}

const inRange = runwayAtPlayhead(mockVideo(50, [[0, 120], [500, 700]]))
assert(inRange.runway === 70, "runway uses the range containing the playhead")
assert(inRange.bufferedEnd === 120, "bufferedEnd matches the active range")

const inGap = runwayAtPlayhead(mockVideo(200, [[0, 120], [500, 700]]))
assert(inGap.runway === 0, "runway is zero when the playhead sits in a buffer gap")

const afterSeek = runwayAtPlayhead(mockVideo(177, [[0, 120], [170, 240], [500, 800]]))
assert(afterSeek.runway === 63, "backward seek ignores stale far-ahead buffer ranges")

const globalMaxWouldBe = 800 - 177
assert(
  afterSeek.runway < globalMaxWouldBe,
  "global max buffered end would inflate runway after seek"
)

const fullBufferSteady = computeHealthScore(600, 1, false, 1)
assert(
  fullBufferSteady >= 95,
  "full buffer with steady lead should score healthy, not 65%"
)

const fullBufferDrain = computeHealthScore(600, 0, false, 1)
assert(
  fullBufferDrain >= 90,
  "full buffer with zero net fill should not be penalized when runway is ample"
)

const thinBufferNoFill = computeHealthScore(20, 0, false, 1)
assert(
  thinBufferNoFill < 50,
  "thin buffer with no fill should stay unhealthy"
)

const comfortPaused = computeHealthScore(60, null, true, 1)
assert(comfortPaused >= 90, "paused with comfortable runway should score well")

assert(
  classifyTier(44.9, 16) !== "emergency",
  "ample runway should not be emergency tier from transient low health score"
)
assert(
  classifyTier(41.5, 13) !== "emergency",
  "40+ second runway should not trigger emergency from fill-rate noise"
)
assert(classifyTier(3, 90) === "emergency", "critically thin runway stays emergency")

if (typeof bumpSeekActivity === "function") {
  bumpSeekActivity()
  assert(
    classifyTier(12, 8) === "aggressive",
    "low runway during seek settling must stay aggressive for refill"
  )
  assert(
    classifyTier(45, 60) === "normal",
    "ample runway stays non-emergency (normal) during seek settling"
  )
  assert(
    classifyTier(45, 60) !== "emergency" && classifyTier(45, 60) !== "aggressive",
    "ample runway must not stay in refill tiers during seek settling"
  )
}

console.log("buffer-health-monitor.test.js: all passed")
