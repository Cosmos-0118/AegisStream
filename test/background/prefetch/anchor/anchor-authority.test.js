/**
 * Run: node test/background/prefetch/anchor/anchor-authority.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../../src/background/config/constants.js")
const reconcilerPath = path.join(__dirname, "../../../../src/background/prefetch/anchor/anchor-reconciler.js")
const authorityPath = path.join(__dirname, "../../../../src/background/prefetch/anchor/anchor-authority.js")

const sandbox = { self: {} }
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), context)
vm.runInContext(fs.readFileSync(reconcilerPath, "utf8"), context)
vm.runInContext(fs.readFileSync(authorityPath, "utf8"), context)

const {
  evaluateAuthorityCommit,
  AnchorAuthority,
  shouldBlockStaleSeekPredictionTeleport,
  getEffectiveAnchorIndex
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const tabState = { hasAnchor: true, anchorIndex: 141, lastDomTeleportAt: 0 }

let decision = evaluateAuthorityCommit(tabState, 140, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "small DOM seek should be ignored")
assert(decision.reason === "dom-seek-below-min-jump", "small DOM seek reason")

decision = evaluateAuthorityCommit(tabState, 31, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "large DOM seek should be allowed")
assert(decision.purgeQueues === true, "141 -> 31 should purge queues")

tabState.lastDomTeleportAt = Date.now()
decision = evaluateAuthorityCommit(tabState, 20, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "DOM seek inside cooldown should be ignored")
assert(decision.reason === "dom-seek-cooldown", "cooldown reason")

tabState.lastDomTeleportAt = 0
tabState.anchorIndex = 50
tabState.hasAnchor = true
decision = evaluateAuthorityCommit(tabState, 65, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "moderate DOM seek allowed")
assert(decision.purgeQueues === false, "15-segment jump should retain overlap")

tabState.anchorIndex = undefined
tabState.hasAnchor = false
decision = evaluateAuthorityCommit(tabState, 14, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "first DOM anchor allowed")
assert(decision.purgeQueues === false, "first DOM anchor should not purge queues")

const scrubState = {
  hasAnchor: true,
  anchorIndex: 40,
  lastDomTeleportAt: Date.now(),
  scrubbingTrainUntil: Date.now() + 5_000
}
decision = evaluateAuthorityCommit(scrubState, 43, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "scrubbing train allows small DOM seek")
assert(decision.purgeQueues === false, "scrub train uses soft commits (reconciliation owns anchor)")

decision = evaluateAuthorityCommit(scrubState, 46, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "scrubbing train allows moderate DOM seek")
assert(decision.purgeQueues === false, "scrub train uses soft commits")
assert(decision.reason === null, "no skip reason during scrubbing train")

scrubState.anchorIndex = 46
decision = evaluateAuthorityCommit(scrubState, 46, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "scrubbing train bypasses DOM cooldown on repeat")
assert(decision.purgeQueues === false, "duplicate scrub target should not purge (jump=0)")

const variantGrace = {
  hasAnchor: true,
  anchorIndex: 8,
  variantSwitchGraceUntil: Date.now() + 8_000,
  variantSwitchAnchorIndex: 8,
  lastDomTeleportAt: 0
}
decision = evaluateAuthorityCommit(variantGrace, 0, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "variant grace blocks spurious teleport to start")
assert(
  decision.reason === "dom-stale-zero" || decision.reason === "variant-switch-grace",
  "stale-zero or variant grace blocks DOM teleport to start"
)

decision = evaluateAuthorityCommit(variantGrace, 7, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "variant grace still blocks small jump below minJump")

const staleDomScrub = {
  hasAnchor: true,
  anchorIndex: 36,
  segments: new Array(142).fill("u"),
  scrubbingTrainUntil: Date.now() + 5_000,
  predictedAnchorIndex: 38,
  predictedAnchorAt: Date.now(),
  lastPlayerObservedIndex: 37,
  lastPlayerObservedAt: Date.now()
}
decision = evaluateAuthorityCommit(staleDomScrub, 0, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "DOM index 0 blocked during scrub when consensus is ~37")
assert(
  decision.reason === "dom-stale-zero" || decision.reason === "scrub-dom-stale-zero",
  "stale DOM zero reason"
)

const staleDomChurn = {
  hasAnchor: true,
  anchorIndex: 39,
  seekChurnAggressiveUntil: Date.now() + 5_000,
  lastDomTeleportAt: 0
}
decision = evaluateAuthorityCommit(staleDomChurn, 0, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "DOM index 0 blocked during seek churn when anchor is 39")
assert(decision.reason === "dom-stale-zero", "dom stale zero during churn")
assert(decision.purgeQueues === false, "stale DOM zero must not purge queues")

const backwardDomAllow = {
  hasAnchor: true,
  anchorIndex: 39,
  lastDomTeleportAt: 0
}
decision = evaluateAuthorityCommit(backwardDomAllow, 2, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "backward DOM seek to index 2 still allowed without churn signals")
assert(decision.purgeQueues === false, "39 -> 2 must not hard-purge even when commit is allowed")

const variantSeek = {
  hasAnchor: true,
  anchorIndex: 37,
  variantSwitchGraceUntil: Date.now() + 8_000,
  variantSwitchAnchorIndex: 37,
  seekChurnAggressiveUntil: Date.now() + 5_000
}
decision = evaluateAuthorityCommit(variantSeek, 0, AnchorAuthority.SEEK_PREDICTION)
assert(decision.allow === false, "seek prediction to 0 blocked during variant grace")
assert(decision.reason === "seek-prediction-stale-zero", "stale seek zero reason")

decision = evaluateAuthorityCommit(variantSeek, 1, AnchorAuthority.SEEK_PREDICTION)
assert(decision.allow === false, "seek prediction to timeline start blocked in variant grace")
assert(
  decision.reason === "seek-prediction-stale-zero" || decision.reason === "variant-switch-grace",
  "stale-zero or variant grace blocks low seek prediction"
)

const staleSeekTeleport = {
  hasAnchor: true,
  anchorIndex: 49,
  variantSwitchAnchorIndex: 49,
  variantSwitchGraceUntil: Date.now() + 8_000
}
assert(
  shouldBlockStaleSeekPredictionTeleport(staleSeekTeleport, 8, 0) === true,
  "seek prediction teleport 49 -> 8 at t=0 should be blocked"
)
assert(
  shouldBlockStaleSeekPredictionTeleport(staleSeekTeleport, 45, 0) === false,
  "small seek drift at t=0 should not be blocked"
)

const churnAnchor = {
  anchorIndex: 50,
  predictedAnchorIndex: 37,
  predictedAnchorAt: Date.now(),
  seekChurnAggressiveUntil: Date.now() + 5_000
}
assert(
  getEffectiveAnchorIndex(churnAnchor) === 37,
  "predicted anchor wins during seek churn when diverged"
)

const prefetchPollution = {
  anchorIndex: 22,
  lastPlayerObservedIndex: 62,
  lastPlayerObservedAt: Date.now(),
  predictedAnchorIndex: 22,
  predictedAnchorAt: Date.now()
}
assert(
  getEffectiveAnchorIndex(prefetchPollution) === 22,
  "prefetch-far-ahead observed index must not override committed anchor"
)

console.log("anchor-authority.test.js: all assertions passed")
