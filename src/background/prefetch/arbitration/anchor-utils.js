(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

ns.isTabInRapidSeek = function isTabInRapidSeek(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.rapidSeekUntil || 0)
}

ns.isTabInSeekChurnAggressive = function isTabInSeekChurnAggressive(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.seekChurnAggressiveUntil || 0)
}

ns.isTabInVariantSwitchGrace = function isTabInVariantSwitchGrace(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.variantSwitchGraceUntil || 0)
}

ns.isTabInTeleportMode = function isTabInTeleportMode(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.teleportModeUntil || 0)
}

ns.isTabInScrubbingTrain = function isTabInScrubbingTrain(tabState) {
  if (typeof ns.isScrubbingTrainActive === "function") {
    return ns.isScrubbingTrainActive(tabState)
  }
  if (!tabState) return false
  return Date.now() < Number(tabState.scrubbingTrainUntil || 0)
}

ns.isPassiveHysteresisMuted = function isPassiveHysteresisMuted(tabState) {
  if (typeof ns.isPassiveHysteresisMuted === "function") {
    return ns.isPassiveHysteresisMuted(tabState)
  }
  if (!tabState) return false
  return Date.now() < Number(tabState.mutePassiveHysteresisUntil || 0)
}

ns.isInEpisodeTransitionGrace = function isInEpisodeTransitionGrace(tabState, now = Date.now()) {
  if (!tabState) return false
  const graceMs = Number(constants.EPISODE_TRANSITION_AUTH_GRACE_MS) || 15_000
  const switchedAt = Number(tabState.episodeSwitchAt || 0)
  if (switchedAt > 0 && now - switchedAt < graceMs) return true
  return tabState.playlistClassification === "new-playback" && switchedAt > 0
}

ns.isInRefreshRecovery = function isInRefreshRecovery(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.refreshRecoveryUntil || 0)
}

ns.isPrefetchBlocked = function isPrefetchBlocked(tabState) {
  if (!tabState) return false
  if (typeof ns.isTabVisibilitySleeping === "function" && ns.isTabVisibilitySleeping(tabState)) return true
  if (tabState.refreshState === ns.REFRESH_STATE_REFRESHING) return true
  if (tabState.refreshState === ns.REFRESH_STATE_AUTH_EXPIRED) return true
  if (tabState.manifestRefreshPending === true) return true
  const pausedUntil = Number(tabState.prefetchPausedUntil || 0)
  return Date.now() < pausedUntil
}

ns.wasRecentlyScrubbing = function wasRecentlyScrubbing(tabState) {
  if (!tabState) return false
  if (ns.isTabInScrubbingTrain(tabState)) return true
  const idleMs = Number(constants.SCRUBBING_TRAIN_IDLE_MS) || 1_000
  const lastScrub = Number(tabState.lastScrubSeekAt || 0)
  return lastScrub > 0 && Date.now() - lastScrub < idleMs + 400
}

ns.isLowRunwayForStallOverride = function isLowRunwayForStallOverride(tabState) {
  if (!tabState) return false
  const runway = Number(tabState.bufferRunwaySec)
  const threshold = Number(constants.SEEK_PASSENGER_STALL_RUNWAY_SEC) ?? 2
  if (Number.isFinite(runway)) return runway <= threshold
  return tabState.bufferTier === ns.TIER_EMERGENCY || tabState.bufferTier === ns.TIER_AGGRESSIVE
}

ns.isActivelyScrubbingPayloadOrState = function isActivelyScrubbingPayloadOrState(tabState, options = {}) {
  if (options.isScrubbing === true) return true
  return typeof ns.isScrubbingTrainActive === "function" && ns.isScrubbingTrainActive(tabState)
}

ns.isRefreshActive = function isRefreshActive(tabState) {
  const stateName = tabState?.refreshState || ns.REFRESH_STATE_HEALTHY
  return stateName === ns.REFRESH_STATE_REFRESHING
}
})()
