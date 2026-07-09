(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state } = ns

ns.markSeekChurnAggressive = function markSeekChurnAggressive(tabState) {
  if (!tabState) return
  const now = Date.now()
  tabState.seekChurnAggressiveUntil = now + constants.SEEK_CHURN_AGGRESSIVE_MS
  tabState.highChurnMode = true
  tabState.rapidSeekUntil = 0
}

ns.noteAnchorChange = function noteAnchorChange(tabState, previousIndex, nextIndex) {
  if (typeof previousIndex !== "number" || typeof nextIndex !== "number") return
  if (previousIndex === nextIndex) return
  const now = Date.now()
  const recent = Array.isArray(tabState.recentAnchorChanges) ? tabState.recentAnchorChanges : []
  const compacted = recent.filter((ts) => now - ts < constants.RAPID_SEEK_WINDOW_MS)
  compacted.push(now)
  tabState.recentAnchorChanges = compacted
  if (compacted.length >= constants.RAPID_SEEK_CHANGE_THRESHOLD) {
    ns.markSeekChurnAggressive(tabState)
  }
}

ns.noteAnchorJump = function noteAnchorJump(tabId) {
  const now = Date.now()
  const entries = state.tabAnchorJumps.get(tabId) || []
  entries.push(now)
  const cutoff = now - constants.PREFETCH_TAB_BURST_WINDOW_MS
  const compacted = entries.filter((ts) => ts >= cutoff)
  state.tabAnchorJumps.set(tabId, compacted)
  return compacted.length
}

ns.getAnchorJumpCount = function getAnchorJumpCount(tabId) {
  const now = Date.now()
  const entries = state.tabAnchorJumps.get(tabId) || []
  const cutoff = now - constants.PREFETCH_TAB_BURST_WINDOW_MS
  const compacted = entries.filter((ts) => ts >= cutoff)
  if (compacted.length !== entries.length) {
    state.tabAnchorJumps.set(tabId, compacted)
  }
  return compacted.length
}

ns.remapChunkIndexViaMediaSequence = function remapChunkIndexViaMediaSequence(tabState, chunkIndex) {
  if (
    chunkIndex !== 0 ||
    typeof tabState?.anchorMediaSequence !== "number" ||
    typeof tabState?.mediaSequence !== "number"
  ) {
    return chunkIndex
  }
  const remapped = tabState.anchorMediaSequence - tabState.mediaSequence
  if (remapped > 10 && remapped < tabState.segments.length) {
    return remapped
  }
  return chunkIndex
}

ns.applyUnifiedSeekPassengerLock = function applyUnifiedSeekPassengerLock(tabState, isScrubbing) {
  if (!tabState || isScrubbing !== true) return
  const now = Date.now()
  const idleMs = Number(constants.SCRUBBING_TRAIN_IDLE_MS) || 1_000
  const passengerMs = Number(constants.UNIFIED_SEEK_PASSENGER_MS) || 800
  tabState.scrubbingTrainUntil = now + idleMs
  tabState.unifiedSeekPassengerUntil = now + passengerMs
  tabState.lastScrubSeekAt = now
  ns.markSeekChurnAggressive(tabState)
}

ns.clearSeekPassengerLock = function clearSeekPassengerLock(tabState) {
  if (!tabState) return
  tabState.scrubbingTrainUntil = 0
  tabState.unifiedSeekPassengerUntil = 0
}
})()
