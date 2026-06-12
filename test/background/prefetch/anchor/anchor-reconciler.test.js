/**
 * Anchor reconciliation: weighted-median consensus promotes the predictor
 * over a stale committed anchor after divergence + dwell.
 *
 * Run: node test/background/prefetch/anchor/anchor-reconciler.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../../src/background/config/constants.js")
const reconcilerPath = path.join(
  __dirname,
  "../../../../src/background/prefetch/anchor/anchor-reconciler.js"
)

const sandbox = { self: {} }
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), context)
vm.runInContext(fs.readFileSync(reconcilerPath, "utf8"), context)

const {
  weightedMedianIndex,
  collectAnchorSignals,
  resolveReconcileTargetIndex,
  evaluateAnchorReconciliation,
  markAnchorReconciliationPromoted
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// --- weightedMedianIndex ---
assert(weightedMedianIndex([]) === null, "empty signals -> null")
assert(
  weightedMedianIndex([{ index: 7, weight: 1 }]) === 7,
  "single signal returns its index"
)
// anchor=0 (w2) vs predictor=8 (w3) + observed=8 (w4): consensus must be 8.
assert(
  weightedMedianIndex([
    { index: 0, weight: 2 },
    { index: 8, weight: 3 },
    { index: 8, weight: 4 }
  ]) === 8,
  "weighted median favors heavier consensus"
)
// Outlier with low weight should not drag the median.
assert(
  weightedMedianIndex([
    { index: 100, weight: 1 },
    { index: 10, weight: 4 },
    { index: 11, weight: 3 }
  ]) === 10,
  "low-weight outlier ignored"
)

// --- collectAnchorSignals freshness ---
const now = Date.now()
const segments = new Array(40).fill("u")
const staleState = {
  segments,
  anchorIndex: 0,
  predictedAnchorIndex: 8,
  predictedAnchorAt: now - 60_000,
  lastPlayerObservedIndex: 8,
  lastPlayerObservedAt: now - 60_000
}
const staleSignals = collectAnchorSignals(staleState, now)
assert(staleSignals.length === 1 && staleSignals[0].source === "anchor", "stale signals excluded")
assert(
  resolveReconcileTargetIndex(staleState, now) === null,
  "anchor-only consensus is not reconcilable"
)

// --- divergence + dwell promotion (the log's anchor=0 / player=8 case) ---
const scrubState = {
  segments,
  anchorIndex: 0,
  predictedAnchorIndex: 8,
  predictedAnchorAt: now,
  lastPlayerObservedIndex: 8,
  lastPlayerObservedAt: now
}

let decision = evaluateAnchorReconciliation(scrubState, now)
assert(decision.promote === false && decision.reason === "dwell-started", "first sight starts dwell")

decision = evaluateAnchorReconciliation(scrubState, now + 100)
assert(decision.promote === false && decision.reason === "dwell-pending", "dwell not elapsed yet")

decision = evaluateAnchorReconciliation(scrubState, now + 600)
assert(decision.promote === true, "divergence sustained past dwell promotes")
assert(decision.targetIndex === 8, `promoted target should be 8, got ${decision.targetIndex}`)

markAnchorReconciliationPromoted(scrubState, now + 600)
assert(scrubState.anchorReconcileDivergenceSince === 0, "promotion resets dwell")

// Cooldown: immediate re-divergence cannot promote again.
scrubState.anchorIndex = 8
scrubState.predictedAnchorIndex = 20
scrubState.lastPlayerObservedIndex = 20
scrubState.predictedAnchorAt = now + 700
scrubState.lastPlayerObservedAt = now + 700
evaluateAnchorReconciliation(scrubState, now + 700) // dwell-started
decision = evaluateAnchorReconciliation(scrubState, now + 1_300)
assert(
  decision.promote === false && decision.reason === "promote-cooldown",
  `promotion inside cooldown must be deferred, got ${decision.reason}`
)
decision = evaluateAnchorReconciliation(scrubState, now + 1_500)
assert(decision.promote === true, "promotion allowed after cooldown")

// --- small divergence never promotes ---
const steadyState = {
  segments,
  anchorIndex: 10,
  predictedAnchorIndex: 12,
  predictedAnchorAt: now,
  lastPlayerObservedIndex: 11,
  lastPlayerObservedAt: now
}
decision = evaluateAnchorReconciliation(steadyState, now)
assert(decision.promote === false && decision.reason === "within-threshold", "small divergence stays")
decision = evaluateAnchorReconciliation(steadyState, now + 10_000)
assert(decision.promote === false, "small divergence never promotes regardless of time")

// --- no committed anchor promotes immediately ---
const anchorlessState = {
  segments,
  predictedAnchorIndex: 5,
  predictedAnchorAt: now,
  lastPlayerObservedIndex: 5,
  lastPlayerObservedAt: now
}
decision = evaluateAnchorReconciliation(anchorlessState, now)
assert(decision.promote === true && decision.reason === "no-anchor", "no anchor -> promote consensus")

// Prefetch webRequest noise far ahead of playhead must not drag consensus.
const prefetchNoiseState = {
  segments,
  anchorIndex: 22,
  predictedAnchorIndex: 22,
  predictedAnchorAt: now,
  lastPlayerObservedIndex: 62,
  lastPlayerObservedAt: now,
  seekChurnAggressiveUntil: now + 5_000
}
const noiseSignals = collectAnchorSignals(prefetchNoiseState, now)
assert(
  !noiseSignals.some((s) => s.source === "observed"),
  "observed signal excluded when far ahead of playhead reference"
)
assert(
  resolveReconcileTargetIndex(prefetchNoiseState, now) === 22,
  "prefetch noise filtered — consensus stays at playhead"
)
decision = evaluateAnchorReconciliation(prefetchNoiseState, now + 10_000)
assert(
  decision.promote === false,
  "prefetch pollution must not promote anchor far ahead"
)

// Catastrophic backward promotion: anchor=29, spurious t≈0 predictor during scrub.
const backwardScrubState = {
  segments,
  anchorIndex: 29,
  predictedAnchorIndex: 1,
  predictedAnchorAt: now,
  lastPlayerObservedIndex: 1,
  lastPlayerObservedAt: now,
  seekChurnAggressiveUntil: now + 5_000
}
const backwardSignals = collectAnchorSignals(backwardScrubState, now)
assert(
  !backwardSignals.some((s) => s.source === "predictor"),
  "stale t≈0 predictor excluded when anchor far ahead"
)
evaluateAnchorReconciliation(backwardScrubState, now)
decision = evaluateAnchorReconciliation(backwardScrubState, now + 600)
assert(
  decision.promote === false && decision.reason === "backward-during-churn",
  `backward scrub must not promote anchor 29 -> 1, got ${decision.reason}`
)

console.log("anchor-reconciler.test.js passed")
