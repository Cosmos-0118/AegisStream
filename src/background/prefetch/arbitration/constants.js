(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

// Refresh state machine
const REFRESH_STATE_HEALTHY = "healthy"
const REFRESH_STATE_REFRESHING = "refreshing"
const REFRESH_STATE_RECOVERING = "recovering"
const REFRESH_STATE_AUTH_EXPIRED = "auth_expired"

// Buffer tiers
const TIER_EMERGENCY = "emergency"
const TIER_AGGRESSIVE = "aggressive"

ns.REFRESH_STATE_HEALTHY = REFRESH_STATE_HEALTHY
ns.REFRESH_STATE_REFRESHING = REFRESH_STATE_REFRESHING
ns.REFRESH_STATE_RECOVERING = REFRESH_STATE_RECOVERING
ns.REFRESH_STATE_AUTH_EXPIRED = REFRESH_STATE_AUTH_EXPIRED
ns.TIER_EMERGENCY = TIER_EMERGENCY
ns.TIER_AGGRESSIVE = TIER_AGGRESSIVE

ns.getManifestRefreshTimeoutMs = function getManifestRefreshTimeoutMs(tabState) {
  const defaultMs = Number(constants.MANIFEST_REFRESH_TIMEOUT_MS) || 20_000
  const inGrace = typeof ns.isInEpisodeTransitionGrace === "function" && ns.isInEpisodeTransitionGrace(tabState)
  if (!inGrace) return defaultMs
  const episodeMs = Number(constants.EPISODE_MANIFEST_REFRESH_TIMEOUT_MS) || 8_000
  return Math.min(defaultMs, episodeMs)
}

ns.computeRefreshRetryDelayMs = function computeRefreshRetryDelayMs(attempt) {
  const base = Math.max(500, Number(constants.MANIFEST_REFRESH_RETRY_BASE_MS) || 1_000)
  const max = Math.max(base, Number(constants.MANIFEST_REFRESH_RETRY_MAX_MS) || 8_000)
  const exponent = Math.max(0, Number(attempt) - 1)
  return Math.min(max, Math.round(base * 2 ** exponent))
}

ns.computeFailureBackoffMs = function computeFailureBackoffMs(attempts, tabState) {
  const exponent = Math.min(
    constants.PREFETCH_MAX_BACKOFF_EXPONENT,
    Math.max(0, Number(attempts || 1) - 1)
  )
  const inGrace = typeof ns.isInEpisodeTransitionGrace === "function" && ns.isInEpisodeTransitionGrace(tabState)
  const baseMs = inGrace
    ? Number(constants.EPISODE_PREFETCH_RETRY_BASE_MS) || 600
    : Number(constants.PREFETCH_BASE_RETRY_MS) || 2_500
  return Math.min(constants.PREFETCH_MAX_RETRY_MS, baseMs * 2 ** exponent)
}

ns.computeCapRetryDelayMs = function computeCapRetryDelayMs(attempt) {
  const base = Math.max(50, Number(constants.PREFETCH_CAP_RETRY_BASE_MS) || 200)
  const max = Math.max(base, Number(constants.PREFETCH_CAP_RETRY_MAX_MS) || 3200)
  const exponent = Math.max(0, Number(attempt) - 1)
  return Math.min(max, Math.round(base * 2 ** exponent))
}
})()
