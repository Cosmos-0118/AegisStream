(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

/**
 * Anchor reconciliation lane.
 *
 * During scrub trains the DOM anchor frequently sticks at a stale index
 * (e.g. 0) while the seek predictor, velocity prewarm, and the player's own
 * segment requests all agree the playhead is somewhere else. The committed
 * anchor drives every prefetch/rescue window, so a stale anchor means
 * bandwidth burned on the wrong segments.
 *
 * This module computes a weighted-median "effective playhead" from all fresh
 * signals and promotes it over the committed anchor when the divergence
 * exceeds a threshold for a dwell period.
 */

function signalFreshnessMs() {
  return Number(constants.ANCHOR_SIGNAL_FRESH_MS) || 3_000
}

/**
 * Collect candidate playhead signals with weights. Higher weight = more
 * trusted. Only signals observed within the freshness window participate.
 */
function collectAnchorSignals(tabState, now = Date.now()) {
  if (!tabState) return []
  const freshMs = signalFreshnessMs()
  const signals = []

  if (typeof tabState.anchorIndex === "number" && tabState.anchorIndex >= 0) {
    signals.push({ source: "anchor", index: tabState.anchorIndex, weight: 2 })
  }
  if (
    typeof tabState.predictedAnchorIndex === "number" &&
    tabState.predictedAnchorIndex >= 0 &&
    now - Number(tabState.predictedAnchorAt || 0) < freshMs
  ) {
    const committed =
      typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : null
    const predicted = tabState.predictedAnchorIndex
    // Spurious t≈0 seek after playlist rotation while slider is far ahead.
    if (!(typeof committed === "number" && committed > 10 && predicted <= 2)) {
      signals.push({ source: "predictor", index: predicted, weight: 3 })
    }
  }
  if (
    typeof tabState.lastPlayerObservedIndex === "number" &&
    tabState.lastPlayerObservedIndex >= 0 &&
    now - Number(tabState.lastPlayerObservedAt || 0) < freshMs
  ) {
    const observed = tabState.lastPlayerObservedIndex
    const anchor =
      typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : null
    const predicted =
      typeof tabState.predictedAnchorIndex === "number" &&
      now - Number(tabState.predictedAnchorAt || 0) < freshMs
        ? tabState.predictedAnchorIndex
        : null
    const reference =
      typeof predicted === "number"
        ? predicted
        : typeof anchor === "number"
          ? anchor
          : null
    const maxAhead =
      Number(constants.SEEK_CHURN_PREFETCH_WINDOW_MIN) ||
      Number(constants.PANIC_PREFETCH_WINDOW) ||
      10
    let includeObserved = true
    if (typeof reference === "number") {
      if (observed > reference + maxAhead) includeObserved = false
      if (
        observed < reference - maxAhead &&
        now < Number(tabState.seekChurnAggressiveUntil || 0)
      ) {
        includeObserved = false
      }
    }
    if (includeObserved) {
      signals.push({ source: "observed", index: observed, weight: 4 })
    }
  }
  if (
    typeof tabState.velocityPredictedIndex === "number" &&
    tabState.velocityPredictedIndex >= 0 &&
    now - Number(tabState.velocityPredictedAt || 0) < freshMs
  ) {
    signals.push({ source: "velocity", index: tabState.velocityPredictedIndex, weight: 2 })
  }
  return signals
}

function weightedMedianIndex(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return null
  const sorted = signals.slice().sort((a, b) => a.index - b.index)
  const totalWeight = sorted.reduce((sum, s) => sum + (Number(s.weight) || 1), 0)
  const half = totalWeight / 2
  let cumulative = 0
  for (const signal of sorted) {
    cumulative += Number(signal.weight) || 1
    if (cumulative >= half) return signal.index
  }
  return sorted[sorted.length - 1].index
}

/** Effective playhead estimate from all fresh signals (null when unknown). */
function resolveReconcileTargetIndex(tabState, now = Date.now()) {
  const signals = collectAnchorSignals(tabState, now)
  if (!signals.length) return null
  // With only the committed anchor available there is nothing to reconcile.
  if (signals.length === 1 && signals[0].source === "anchor") return null
  return weightedMedianIndex(signals)
}

/**
 * Decide whether the predictor consensus should be promoted over the
 * committed anchor. Tracks dwell state on the tabState so a transient
 * single-sample disagreement never causes an anchor jump.
 */
function evaluateAnchorReconciliation(tabState, now = Date.now()) {
  if (!tabState?.segments?.length) {
    return { promote: false, reason: "no-playlist" }
  }
  const anchor = typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : null
  const target = resolveReconcileTargetIndex(tabState, now)
  if (typeof target !== "number") {
    tabState.anchorReconcileDivergenceSince = 0
    return { promote: false, reason: "no-signals" }
  }
  if (typeof anchor !== "number") {
    // No committed anchor at all — promote immediately.
    return { promote: true, targetIndex: target, divergence: null, reason: "no-anchor" }
  }

  const divergenceThreshold =
    Number(constants.ANCHOR_RECONCILE_DIVERGENCE_SEGMENTS) || 3
  const dwellMs = Number(constants.ANCHOR_RECONCILE_DWELL_MS) || 500
  const minIntervalMs = Number(constants.ANCHOR_RECONCILE_MIN_INTERVAL_MS) || 800

  const divergence = Math.abs(target - anchor)
  if (divergence <= divergenceThreshold) {
    tabState.anchorReconcileDivergenceSince = 0
    return { promote: false, divergence, targetIndex: target, reason: "within-threshold" }
  }

  if (target < anchor - divergenceThreshold) {
    const churnUntil = Math.max(
      Number(tabState.seekChurnAggressiveUntil || 0),
      Number(tabState.scrubbingTrainUntil || 0)
    )
    if (now < churnUntil) {
      tabState.anchorReconcileDivergenceSince = 0
      return {
        promote: false,
        divergence,
        targetIndex: target,
        reason: "backward-during-churn"
      }
    }
    if (anchor > 10 && target <= 2) {
      tabState.anchorReconcileDivergenceSince = 0
      return {
        promote: false,
        divergence,
        targetIndex: target,
        reason: "stale-timeline-zero"
      }
    }
  }

  const since = Number(tabState.anchorReconcileDivergenceSince || 0)
  if (!since) {
    tabState.anchorReconcileDivergenceSince = now
    return { promote: false, divergence, targetIndex: target, reason: "dwell-started" }
  }
  if (now - since < dwellMs) {
    return { promote: false, divergence, targetIndex: target, reason: "dwell-pending" }
  }
  if (now - Number(tabState.anchorReconcileLastPromoteAt || 0) < minIntervalMs) {
    return { promote: false, divergence, targetIndex: target, reason: "promote-cooldown" }
  }

  return { promote: true, divergence, targetIndex: target, reason: "divergence-dwell" }
}

function markAnchorReconciliationPromoted(tabState, now = Date.now()) {
  if (!tabState) return
  tabState.anchorReconcileLastPromoteAt = now
  tabState.anchorReconcileDivergenceSince = 0
}

ns.collectAnchorSignals = collectAnchorSignals
ns.weightedMedianIndex = weightedMedianIndex
ns.resolveReconcileTargetIndex = resolveReconcileTargetIndex
ns.evaluateAnchorReconciliation = evaluateAnchorReconciliation
ns.markAnchorReconciliationPromoted = markAnchorReconciliationPromoted
})()
