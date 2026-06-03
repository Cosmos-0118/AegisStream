/**
 * Run: node test/background/prefetch/network-generation.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const genPath = path.join(__dirname, "../../../src/background/prefetch/network-generation.js")

const logs = []
const sandbox = {
  chrome: {
    tabs: {
      sendMessage: () => Promise.resolve()
    }
  },
  self: {
    AegisBackground: {
      addLog: (_level, msg) => logs.push(msg)
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(genPath, "utf8"), vm.createContext(sandbox))

const {
  bumpNetworkGeneration,
  bumpPlaybackGeneration,
  evaluateLifecycleAdvancement,
  isNonDestructiveLifecycleSource,
  tryRegisterPrefetchDownload,
  isCurrentNetworkGeneration
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const tabState = { networkGeneration: 0, prefetchDownloadRegistry: new Set() }
const gen1 = bumpNetworkGeneration(1, tabState, "test")
assert(gen1 === 1, "first bump should be 1")
assert(tryRegisterPrefetchDownload(tabState, "https://cdn.example.com/a.ts"), "register ok")
assert(
  !tryRegisterPrefetchDownload(tabState, "https://cdn.example.com/a.ts"),
  "duplicate register blocked"
)
bumpNetworkGeneration(1, tabState, "seek")
assert(gen1 !== tabState.networkGeneration, "second bump increments")
assert(
  tryRegisterPrefetchDownload(tabState, "https://cdn.example.com/a.ts"),
  "register allowed after bump"
)
assert(!isCurrentNetworkGeneration(tabState, gen1), "stale generation rejected")

assert(
  isNonDestructiveLifecycleSource("delegate-chunk-observed"),
  "chunk observed is non-destructive"
)
const { isSoftScrubDelegateSource, isDestructiveDelegateSource } =
  sandbox.self.AegisBackground
assert(
  isSoftScrubDelegateSource("delegate-scrub-velocity-prewarm"),
  "scrub velocity prewarm is soft delegate"
)
assert(
  isSoftScrubDelegateSource("delegate-scrub-snap-back"),
  "scrub snap-back is soft delegate"
)
assert(
  !isDestructiveDelegateSource("delegate-scrub-velocity-prewarm"),
  "scrub velocity prewarm must not purge playback generation"
)
assert(
  isSoftScrubDelegateSource("delegate-scrub-snap-back"),
  "snap-back is soft delegate during churn"
)
assert(
  !isDestructiveDelegateSource("delegate-scrub-snap-back"),
  "snap-back must not purge playback generation"
)
assert(
  isSoftScrubDelegateSource("delegate-dom-seeked"),
  "dom-seeked during soft anchor must be soft delegate"
)
assert(
  !isDestructiveDelegateSource("delegate-dom-seeked"),
  "dom-seeked must not purge playback generation on delegate"
)
const scrubTabState = {
  ...tabState,
  scrubbingTrainUntil: Date.now() + 60_000
}
const velocityLaneTabState = {
  ...tabState,
  lastScrubVelocityScheduleAt: Date.now()
}
const {
  shouldDeferSeekPredictionPrefetch,
  isVelocityPrefetchLaneActive,
  isSeekPredictionPassengerPhase
} = sandbox.self.AegisBackground
const passengerLockTabState = {
  ...tabState,
  unifiedSeekPassengerUntil: Date.now() + 60_000
}
assert(
  isSeekPredictionPassengerPhase(passengerLockTabState),
  "unified seek passenger lock defers before scrub train flag propagates"
)
assert(
  shouldDeferSeekPredictionPrefetch(passengerLockTabState),
  "passenger lock triggers defer"
)
assert(
  isSoftScrubDelegateSource("delegate-seek-prediction", scrubTabState),
  "seek-prediction during scrub train must be soft delegate"
)
assert(
  !isDestructiveDelegateSource("delegate-seek-prediction", scrubTabState),
  "seek-prediction must not purge playback during scrub train"
)
assert(
  isDestructiveDelegateSource("delegate-seek-prediction", tabState),
  "seek-prediction outside scrub train may still be destructive"
)
assert(
  shouldDeferSeekPredictionPrefetch(scrubTabState),
  "seek prediction deferred during scrub train"
)
assert(
  shouldDeferSeekPredictionPrefetch(velocityLaneTabState),
  "seek prediction deferred while velocity lane is active"
)
assert(
  isSoftScrubDelegateSource("delegate-seek-prediction", velocityLaneTabState),
  "seek-prediction soft while velocity lane active"
)
assert(
  isVelocityPrefetchLaneActive(velocityLaneTabState),
  "velocity lane detects recent prewarm schedule"
)
assert(
  !isNonDestructiveLifecycleSource("rescue-lane"),
  "rescue lane must bump playback to invalidate stale work"
)
const beforeObserved = tabState.playbackGeneration
const advanced = evaluateLifecycleAdvancement(1, tabState, "delegate-chunk-observed", 7)
assert(advanced === false, "chunk observed must not advance playback")
assert(tabState.playbackGeneration === beforeObserved, "playback generation unchanged")
assert(tabState.lastObservedIndex === 7, "observed index recorded")
assert(
  evaluateLifecycleAdvancement(1, tabState, "delegate-scrub-velocity-prewarm", 4) === false,
  "scrub prewarm must not advance playback"
)
assert(
  evaluateLifecycleAdvancement(1, tabState, "delegate-dom-seeked", 12) === false,
  "dom-seeked must not advance playback during soft anchor"
)
assert(
  (tabState.playbackGeneration || tabState.networkGeneration || 0) ===
    (beforeObserved || tabState.networkGeneration || 0),
  "playback generation unchanged after soft scrub prewarm"
)

logs.length = 0
const genBeforeDelegate = tabState.playbackGeneration || tabState.networkGeneration || 0
bumpPlaybackGeneration(1, tabState, "delegate-scrub-velocity-prewarm")
assert(
  !logs.some((line) => line.includes("Playback generation")),
  "delegate-scrub-velocity-prewarm must never log Playback generation"
)
logs.length = 0
bumpPlaybackGeneration(1, tabState, "delegate-chunk-observed")
assert(
  !logs.some((line) => line.includes("Playback generation")),
  "delegate-chunk-observed must never log Playback generation"
)
logs.length = 0
bumpPlaybackGeneration(1, tabState, "delegate-dom-seeked")
assert(
  !logs.some((line) => line.includes("Playback generation")),
  "delegate-dom-seeked must never log Playback generation"
)
logs.length = 0
bumpPlaybackGeneration(1, scrubTabState, "delegate-seek-prediction")
assert(
  !logs.some((line) => line.includes("Playback generation")),
  "delegate-seek-prediction must not log Playback generation during scrub train"
)
assert(
  (tabState.playbackGeneration || tabState.networkGeneration || 0) === genBeforeDelegate,
  "delegate-chunk-observed must not increment playback generation"
)

console.log("network-generation.test.js: OK")
