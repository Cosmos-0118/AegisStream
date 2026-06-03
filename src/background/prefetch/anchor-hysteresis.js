(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

const STREAK_THRESHOLD = Number(constants.ANCHOR_MONOTONIC_STREAK_THRESHOLD) || 2
const NEARBY_DELTA = 2

/**
 * Passive (network) anchor lane: debounce extreme jumps unless the player
 * proves the new neighborhood with monotonic consecutive segment requests.
 */
function evaluatePassiveAnchorSignal(tabState, observedIndex, currentAnchor) {
  const current =
    typeof currentAnchor === "number" ? currentAnchor : tabState.anchorIndex
  if (typeof current !== "number" || typeof observedIndex !== "number") {
    return observedIndex
  }

  const delta = Math.abs(observedIndex - current)
  if (delta <= NEARBY_DELTA) {
    tabState.anchorPendingCount = 0
    tabState.anchorPendingIndex = null
    tabState.anchorLockStartedAt = 0
    return observedIndex
  }

  const pending = tabState.anchorPendingIndex
  if (pending !== observedIndex) {
    if (typeof pending === "number" && observedIndex === pending + 1) {
      tabState.anchorPendingCount = Number(tabState.anchorPendingCount || 0) + 1
    } else {
      tabState.anchorPendingCount = 1
    }
    tabState.anchorPendingIndex = observedIndex
    if (!tabState.anchorLockStartedAt) {
      tabState.anchorLockStartedAt = Date.now()
    }
  } else {
    tabState.anchorPendingCount = Number(tabState.anchorPendingCount || 0) + 1
  }

  if (tabState.anchorPendingCount >= STREAK_THRESHOLD) {
    tabState.anchorPendingCount = 0
    tabState.anchorPendingIndex = null
    tabState.anchorLockStartedAt = 0
    return observedIndex
  }

  return current
}

function resetPassiveAnchorDeferral(tabState) {
  if (!tabState) return
  tabState.anchorPendingIndex = null
  tabState.anchorPendingCount = 0
  tabState.anchorLockStartedAt = 0
}

ns.evaluatePassiveAnchorSignal = evaluatePassiveAnchorSignal
ns.resetPassiveAnchorDeferral = resetPassiveAnchorDeferral
})()
