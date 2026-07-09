(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

ns.beginRefreshRecovery = function beginRefreshRecovery(tabState) {
  if (!tabState) return
  tabState.refreshRecoveryUntil = Date.now() + constants.REFRESH_RECOVERY_MAX_MS
  tabState.refreshRecoverySuccessCount = 0
}

ns.clearRefreshRecovery = function clearRefreshRecovery(tabState) {
  if (!tabState) return
  tabState.refreshRecoveryUntil = 0
  tabState.refreshRecoverySuccessCount = 0
}

ns.noteRefreshRecoverySuccess = function noteRefreshRecoverySuccess(tabId, tabState) {
  if (!ns.isInRefreshRecovery(tabState) && tabState?.refreshState !== ns.REFRESH_STATE_RECOVERING) return
  tabState.refreshRecoverySuccessCount = Number(tabState.refreshRecoverySuccessCount || 0) + 1
  if (tabState.refreshRecoverySuccessCount >= constants.REFRESH_RECOVERY_SUCCESS_TARGET) {
    if (Number.isFinite(tabId)) ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_HEALTHY, "warmup complete")
    else { ns.clearRefreshRecovery(tabState); tabState.refreshState = ns.REFRESH_STATE_HEALTHY; tabState.manifestRefreshPending = false }
  }
}

ns.tabPlaylistLastActiveAt = function tabPlaylistLastActiveAt(tabState) {
  if (!tabState) return 0
  return Math.max(Number(tabState.updatedAt || 0), Number(tabState.playlistRefreshedAt || 0), Number(tabState.tokensRefreshedAt || 0), Number(tabState.warmRecoveryAppliedAt || 0))
}

ns.tabNeedsPlaylistRecovery = function tabNeedsPlaylistRecovery(tabState, options = {}) {
  if (!tabState) return false
  if (tabState.authBlockedUntil && Date.now() < Number(tabState.authBlockedUntil || 0)) return false
  const playlistUrl = tabState.mediaPlaylistUrl || tabState.lastMediaPlaylistUrl
  if (!playlistUrl) return false
  const segmentsEmpty = !Array.isArray(tabState.segments) || tabState.segments.length === 0
  const staleMs = Number(constants.PLAYLIST_IDLE_STALE_MS) || 120_000
  const lastActiveAt = ns.tabPlaylistLastActiveAt(tabState)
  const idleStale = lastActiveAt > 0 && Date.now() - lastActiveAt > staleMs
  if (tabState.warmRecovery === true && segmentsEmpty) return true
  if (tabState.playlistRecaptureRequired === true) return true
  if (segmentsEmpty) return true
  const hiddenMs = Number(options.hiddenDurationMs || 0)
  const visibilityStaleMs = Number(constants.VISIBILITY_PLAYLIST_REFRESH_MS) || 30_000
  if (options.forceAfterIdle && hiddenMs >= visibilityStaleMs) return true
  if (options.forceAfterIdle && idleStale) return true
  return false
}

ns.ensureTabPlaylistRecovery = async function ensureTabPlaylistRecovery(tabId, reason, options = {}) {
  if (!Number.isFinite(tabId) || tabId < 0) return false
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState) return false
  if (!options.force && !ns.tabNeedsPlaylistRecovery(tabState, options)) return false

  if (!tabState.mediaPlaylistUrl && tabState.lastMediaPlaylistUrl) tabState.mediaPlaylistUrl = tabState.lastMediaPlaylistUrl
  if (!tabState.mediaPlaylistUrl) return false

  const now = Date.now()
  const authBlockedUntil = Number(tabState.authBlockedUntil || 0)
  if (authBlockedUntil && now < authBlockedUntil) return false

  const debounceMs = Number(constants.PLAYLIST_RECOVERY_DEBOUNCE_MS) || 5_000
  const lastAttempt = Number(tabState.lastPlaylistRecoveryAt || 0)
  const attemptKey = options.attemptKey || `${reason}:${tabState.mediaPlaylistUrl || tabState.lastMediaPlaylistUrl || "unknown"}`
  if (!options.force && now - lastAttempt < debounceMs) return false
  if (!options.force && tabState.lastPlaylistRecoveryReason === reason && tabState.lastPlaylistRecoveryAttemptKey === attemptKey && now - lastAttempt < debounceMs * 2) return false
  tabState.lastPlaylistRecoveryAt = now
  tabState.lastPlaylistRecoveryReason = reason
  tabState.lastPlaylistRecoveryAttemptKey = attemptKey
  tabState.playlistRecaptureRequired = true
  tabState.warmRecovery = true
  tabState.playlistCaptureState = tabState.playlistCaptureState === ns.PLAYLIST_CAPTURE_STATE?.AUTH_BLOCKED ? tabState.playlistCaptureState : "needs-capture"
  if (options.preferRecapture !== false) tabState.recoveryPreferredMode = "recapture"

  addLog("INFO", `Playlist recovery on tab ${tabId} (${reason}) — recapturing manifest before cache serve`)
  return ns.requestManifestRefreshForTab(tabId, reason)
}

ns.blockPlaylistAuthRecovery = function blockPlaylistAuthRecovery(tabState, cooldownMs) {
  if (!tabState) return
  tabState.authBlockedUntil = Date.now() + Math.max(30_000, Number(cooldownMs) || 120_000)
  tabState.playlistRecaptureRequired = false
  tabState.warmRecovery = false
  tabState.recoveryPreferredMode = "blocked"
}
})()
