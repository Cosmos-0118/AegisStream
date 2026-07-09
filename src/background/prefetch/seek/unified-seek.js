(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

ns.handleUnifiedSeekState = function handleUnifiedSeekState(tabId, rawPayload = {}) {
  if (!Number.isFinite(tabId)) return
  const payload = typeof ns.normalizeUnifiedSeekPayload === "function" ? ns.normalizeUnifiedSeekPayload(rawPayload) : rawPayload
  if (!payload) return

  let tabState = state.playlistByTab.get(tabId)
  if (!tabState) {
    tabState = { segments: [], updatedAt: Date.now() }
    state.playlistByTab.set(tabId, tabState)
  }

  const now = Date.now()
  const isScrubbing = payload.isScrubbing === true
  const scrubTrainEnded = payload.scrubTrainEnded === true

  if (isScrubbing) {
    ns.applyUnifiedSeekPassengerLock(tabState, true)
    if (!ns.isTabInScrubbingTrain(tabState)) {
      if (typeof ns.invalidateSeekPredictionsForScrub === "function") ns.invalidateSeekPredictionsForScrub(tabId)
    }
  } else if (scrubTrainEnded) {
    const wasActive = ns.isTabInScrubbingTrain(tabState) || Number(tabState.unifiedSeekPassengerUntil || 0) > now
    ns.clearSeekPassengerLock(tabState)
    if (wasActive && tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      ns.triggerScrubSnapBackBurst(tabId, tabState, tabState.anchorIndex)
    }
  }

  const currentTimeSec = Number(payload.timeSec)
  if (!Number.isFinite(currentTimeSec)) return

  if (payload.isRelease === true) tabState.lastSeekReleaseAt = now

  if (!tabState.segments?.length) {
    if (payload.isRelease === true && ns.maybeBreakPassengerLockForStallRecovery(tabId, tabState, { isRelease: true, reason: "release-no-playlist" })) return
    return
  }

  let estimatedIndex = Number(payload.estimatedIndex)
  if (!Number.isFinite(estimatedIndex)) {
    estimatedIndex = ns.estimateManifestIndexFromTime(currentTimeSec, tabState.segmentDurations, {
      totalDurationSec: tabState.playlistFingerprint?.totalDuration, segmentCount: tabState.segments.length, fallbackSegmentDurationSec: 4
    })
  }
  if (typeof estimatedIndex !== "number") return

  const passengerPhase = isScrubbing || (typeof ns.isSeekPredictionPassengerPhase === "function" && ns.isSeekPredictionPassengerPhase(tabState))

  tabState.predictedAnchorIndex = estimatedIndex
  tabState.predictedAnchorAt = now

  if (passengerPhase) {
    if (typeof ns.recordSeekPrediction === "function") ns.recordSeekPrediction(tabId, { predictedIndex: estimatedIndex, currentTimeSec, previousIndex: tabState.hasAnchor ? tabState.anchorIndex : null, teleport: false, source: "seek-prediction-scrub-observe" })

    const predictedVelocityIndex = Number(payload.velocityPredictedIndex)
    const velocitySegPerSec = Number(payload.velocitySegPerSec)
    const minScrubVelocity = Number(constants.SCRUB_VELOCITY_MIN_SEGMENTS_PER_SEC) || 0.5
    if (Number.isFinite(velocitySegPerSec)) {
      const scrubTargetIndex = Math.abs(velocitySegPerSec) >= minScrubVelocity && Number.isFinite(predictedVelocityIndex) ? predictedVelocityIndex : estimatedIndex
      if (Number.isFinite(scrubTargetIndex)) {
        tabState.velocityPredictedIndex = Math.max(0, Math.round(scrubTargetIndex))
        tabState.velocityPredictedAt = now
        const scrubCurrentIndex = Math.max(estimatedIndex, typeof payload.currentIndex === "number" ? Math.round(payload.currentIndex) : estimatedIndex)
        ns.handleScrubVelocityPrefetch(tabId, { predictedIndex: Math.max(scrubTargetIndex, scrubCurrentIndex), velocitySegPerSec, currentIndex: scrubCurrentIndex, estimatedIndex })
      }
    }
    ns.maybeReconcileAnchor(tabId, tabState, now)
    if (payload.isRelease === true && !isScrubbing) {
      if (ns.maybeBreakPassengerLockForStallRecovery(tabId, tabState, { isRelease: true, isScrubbing: false, reason: "release-low-runway" })) {
        ns.handleSeekPrediction(tabId, currentTimeSec, { fromUnified: true, stallOverride: true })
      }
    }
    return
  }

  if (payload.isRelease === true && !isScrubbing) {
    if (ns.maybeBreakPassengerLockForStallRecovery(tabId, tabState, { isRelease: true, isScrubbing: false, reason: "release-low-runway" })) {
      ns.handleSeekPrediction(tabId, currentTimeSec, { fromUnified: true, stallOverride: true })
    }
    return
  }

  ns.handleSeekPrediction(tabId, currentTimeSec, { fromUnified: true })
}
})()
