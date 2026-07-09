(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

ns.triggerScrubSnapBackBurst = function triggerScrubSnapBackBurst(tabId, tabState, targetIndex) {
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return
  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))
  const now = Date.now()
  const minGap = Number(constants.SCRUB_SNAP_BACK_TRIGGER_MIN_MS) || 900
  const indexDelta = Number(constants.SCRUB_SNAP_BACK_INDEX_DELTA) || 3
  const lastAt = Number(tabState.lastScrubSnapBackAt || 0)
  const lastIndex = tabState.lastScrubSnapBackIndex
  if (now - lastAt < minGap && typeof lastIndex === "number" && Math.abs(clampedTarget - lastIndex) < indexDelta) return

  tabState.lastScrubSnapBackAt = now
  tabState.lastScrubSnapBackIndex = clampedTarget

  const radius = Math.max(Number(constants.SCRUB_SNAP_BACK_RADIUS) || 15, Number(state.settings.prefetchWindow) || 8)
  const start = Math.min(clampedTarget + 1, tabState.segments.length - 1)

  ns.markSeekChurnAggressive(tabState)
  tabState.scrubSnapBackUntil = now + (Number(constants.SCRUB_SNAP_BACK_MS) || 5_000)
  tabState.teleportModeUntil = now + constants.TELEPORT_MODE_DURATION_MS
  tabState.teleportTargetIndex = clampedTarget
  tabState.lastScheduledFromIndex = -1

  addLog("INFO", `Slider released at index ${clampedTarget}. Triggering immediate Snap-Back buffer shield (radius=${radius}, tab ${tabId}).`)
  void ns.schedulePrefetch(tabId, tabState.segments, start, { force: true, source: "scrub-snap-back", prefetchWindowOverride: radius })
}

ns.handleScrubbingTrainState = function handleScrubbingTrainState(tabId, payload = {}) {
  if (!Number.isFinite(tabId)) return
  let tabState = state.playlistByTab.get(tabId)
  if (!tabState) {
    tabState = { segments: [], updatedAt: Date.now() }
    state.playlistByTab.set(tabId, tabState)
  }
  const now = Date.now()
  const idleMs = Number(constants.SCRUBBING_TRAIN_IDLE_MS) || 1_000
  if (payload.active === true) {
    tabState.scrubbingTrainUntil = now + idleMs
    tabState.lastScrubSeekAt = now
    ns.markSeekChurnAggressive(tabState)
    return
  }
  tabState.scrubbingTrainUntil = 0
  if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
    ns.triggerScrubSnapBackBurst(tabId, tabState, tabState.anchorIndex)
  }
}

ns.handleScrubVelocityPrefetch = function handleScrubVelocityPrefetch(tabId, payload = {}) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length) return
  const now = Date.now()
  const minInterval = Number(constants.SCRUB_DELEGATE_MIN_INTERVAL_MS) || 400
  const lastDelegateAt = Number(tabState.lastScrubVelocityDelegateAt || 0)
  if (now - lastDelegateAt < minInterval) return
  tabState.lastScrubVelocityDelegateAt = now
  tabState.lastScrubVelocityScheduleAt = now

  let predictedIndex = Number(payload.predictedIndex)
  if (!Number.isFinite(predictedIndex)) return
  const effectiveAnchor = typeof ns.getEffectiveAnchorIndex === "function" ? ns.getEffectiveAnchorIndex(tabState) : tabState.anchorIndex
  const seekObservedIndex = typeof tabState.predictedAnchorIndex === "number" ? tabState.predictedAnchorIndex : effectiveAnchor
  const scrubContext = ns.isScrubbingTrainActive?.(tabState) || ns.isTabInSeekChurnAggressive(tabState) || now < Number(tabState.scrubbingTrainUntil || 0) + 400

  if (typeof effectiveAnchor === "number" && predictedIndex < effectiveAnchor - 3) predictedIndex = effectiveAnchor
  else if (typeof seekObservedIndex === "number" && seekObservedIndex > 6 && (scrubContext || Math.abs(predictedIndex - seekObservedIndex) > 8) && (predictedIndex <= 2 || Math.abs(predictedIndex - seekObservedIndex) > 3)) {
    predictedIndex = seekObservedIndex
  }

  const radius = Math.max(1, Number(constants.SCRUB_VELOCITY_PREFETCH_RADIUS) || 3)
  let clamped = Math.max(0, Math.min(Math.round(predictedIndex), tabState.segments.length - 1))
  const kalmanIndex = Number.isFinite(Number(payload.currentIndex)) ? Math.round(Number(payload.currentIndex)) : null
  const domIndex = typeof seekObservedIndex === "number" ? seekObservedIndex : Number.isFinite(Number(payload.estimatedIndex)) ? Math.round(Number(payload.estimatedIndex)) : null
  const playheadIndex = kalmanIndex !== null && domIndex !== null ? Math.max(kalmanIndex, domIndex) : kalmanIndex ?? domIndex

  if (scrubContext && typeof playheadIndex === "number" && playheadIndex > clamped + 2) clamped = playheadIndex
  const maxJump = Number(constants.SCRUB_VELOCITY_MAX_JUMP_SEGMENTS) || 8
  if (typeof playheadIndex === "number" && Math.abs(clamped - playheadIndex) > maxJump) clamped = Math.max(0, Math.min(tabState.segments.length - 1, playheadIndex + Math.sign(clamped - playheadIndex) * maxJump))
  if (typeof effectiveAnchor === "number" && effectiveAnchor > 10 && clamped <= 2 && (scrubContext || now < Number(tabState.anchorRotationGraceUntil || 0))) return

  ns.pruneInflightSegmentIndices(tabState, typeof playheadIndex === "number" ? playheadIndex : clamped)

  let start, windowSize = radius * 2 + 1
  if (scrubContext && typeof playheadIndex === "number") { start = Math.max(0, playheadIndex); windowSize = Math.min(tabState.segments.length - start, radius + 6) }
  else if (typeof playheadIndex === "number" && playheadIndex > clamped + 2) { start = Math.max(0, playheadIndex); windowSize = Math.min(tabState.segments.length - start, radius + 6) }
  else start = Math.max(0, clamped - radius)

  let needed = ns.countPrefetchWindowNeedingFetch(tabId, tabState, start, windowSize)
  if (needed === 0 && tabState.activeInflightSegmentIndices instanceof Set && tabState.activeInflightSegmentIndices.size > 0) {
    let overlapsWindow = false
    for (const idx of tabState.activeInflightSegmentIndices) { if (idx >= start && idx < start + windowSize) overlapsWindow = true }
    if (!overlapsWindow) { tabState.activeInflightSegmentIndices.clear(); needed = ns.countPrefetchWindowNeedingFetch(tabId, tabState, start, windowSize) }
  }
  if (needed === 0) { if (typeof ns.recordScrubPrewarmSkippedDedup === "function") ns.recordScrubPrewarmSkippedDedup(); return }
  if (typeof ns.recordScrubPrewarmScheduled === "function") ns.recordScrubPrewarmScheduled()
  void ns.schedulePrefetch(tabId, tabState.segments, start, { force: true, source: "scrub-velocity-prewarm", prefetchWindowOverride: windowSize })
}

ns.maybeBreakPassengerLockForStallRecovery = function maybeBreakPassengerLockForStallRecovery(tabId, tabState, options = {}) {
  if (!tabState) return false
  if (ns.isActivelyScrubbingPayloadOrState(tabState, options)) return false

  const now = Date.now()
  const releaseWindow = Number(constants.SEEK_RELEASE_STALL_OVERRIDE_MS) || 3_000
  const recentRelease = options.isRelease === true && options.isScrubbing !== true &&
    Number(tabState.lastSeekReleaseAt || 0) > 0 && now - Number(tabState.lastSeekReleaseAt) < releaseWindow
  const inPassenger = typeof ns.isSeekPredictionPassengerPhase === "function" && ns.isSeekPredictionPassengerPhase(tabState)
  if (!inPassenger && options.force !== true) return false
  if (!recentRelease && options.stall !== true && options.force !== true) return false
  if (!ns.isLowRunwayForStallOverride(tabState) && options.force !== true) return false

  ns.clearSeekPassengerLock(tabState)
  addLog("INFO", `Seek passenger lock released on tab ${tabId} (${options.reason || "stall-override"}) — macro predictor may drive recovery`)
  return true
}
})()
