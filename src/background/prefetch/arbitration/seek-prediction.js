(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

ns.handleSeekPrediction = function handleSeekPrediction(tabId, currentTimeSec, options = {}) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length) return

  if (typeof ns.isSeekPredictionPassengerPhase === "function" && ns.isSeekPredictionPassengerPhase(tabState)) {
    const estimatedIndex = ns.estimateManifestIndexFromTime(currentTimeSec, tabState.segmentDurations, {
      totalDurationSec: tabState.playlistFingerprint?.totalDuration, segmentCount: tabState.segments.length, fallbackSegmentDurationSec: 4
    })
    if (typeof estimatedIndex === "number") {
      if (typeof ns.recordSeekPrediction === "function") ns.recordSeekPrediction(tabId, { predictedIndex: estimatedIndex, currentTimeSec, previousIndex: tabState.hasAnchor ? tabState.anchorIndex : null, teleport: false, source: "seek-prediction-scrub-suppressed" })
      tabState.predictedAnchorIndex = estimatedIndex
      tabState.predictedAnchorAt = Date.now()
      ns.maybeReconcileAnchor(tabId, tabState)
    }
    return
  }

  if (typeof ns.isSeekPredictionEnabled === "function" && !ns.isSeekPredictionEnabled()) {
    if (typeof ns.notePainPredictorBlocked === "function") ns.notePainPredictorBlocked()
    return
  }

  const estimatedIndex = ns.estimateManifestIndexFromTime(currentTimeSec, tabState.segmentDurations, {
    totalDurationSec: tabState.playlistFingerprint?.totalDuration, segmentCount: tabState.segments.length, fallbackSegmentDurationSec: 4
  })
  if (typeof estimatedIndex !== "number") return

  tabState.predictedAnchorIndex = estimatedIndex
  tabState.predictedAnchorAt = Date.now()

  const previousIndex = tabState.hasAnchor ? tabState.anchorIndex : null
  const deferPrediction = typeof ns.shouldDeferSeekPredictionPrefetch === "function" ? ns.shouldDeferSeekPredictionPrefetch(tabState) : ns.isTabInScrubbingTrain(tabState)

  if (typeof ns.recordSeekPrediction === "function") ns.recordSeekPrediction(tabId, { predictedIndex: estimatedIndex, currentTimeSec, previousIndex, teleport: false, source: deferPrediction ? "seek-prediction-scrub-suppressed" : "seek-prediction" })
  if (deferPrediction) return

  const teleportThreshold = Number(constants.TELEPORT_MODE_JUMP_THRESHOLD) || 20

  if (typeof previousIndex === "number") {
    const jump = Math.abs(estimatedIndex - previousIndex)
    if (typeof ns.shouldBlockStaleSeekPredictionTeleport === "function" && ns.shouldBlockStaleSeekPredictionTeleport(tabState, estimatedIndex, currentTimeSec)) { ns.maybeReconcileAnchor(tabId, tabState); return }
    if (typeof ns.shouldBlockStaleTimelineSeekTarget === "function" && ns.shouldBlockStaleTimelineSeekTarget(tabState, estimatedIndex)) { ns.maybeReconcileAnchor(tabId, tabState); return }
    if (jump >= teleportThreshold) {
      const authority = ns.AnchorAuthority?.SEEK_PREDICTION ?? 2
      ns.commitAnchorFromAuthority(tabId, estimatedIndex, authority, "seek-prediction")
      return
    }
    if (jump > 1) {
      ns.markSeekChurnAggressive(tabState)
      tabState.anchorIndex = estimatedIndex
      if (typeof tabState.mediaSequence === "number") tabState.anchorMediaSequence = tabState.mediaSequence + estimatedIndex
      void ns.schedulePrefetch(tabId, tabState.segments, Math.max(0, estimatedIndex - 1), { force: true, source: "seek-prediction" })
    }
    return
  }

  tabState.hasAnchor = true
  tabState.anchorIndex = estimatedIndex
  if (typeof tabState.mediaSequence === "number") tabState.anchorMediaSequence = tabState.mediaSequence + estimatedIndex
  void ns.schedulePrefetch(tabId, tabState.segments, Math.max(0, estimatedIndex), { force: true, source: "seek-prediction" })
}
})()
