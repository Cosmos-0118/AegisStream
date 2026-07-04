(() => {
var ns = (self.AegisBackground ||= {})
const { state } = ns

ns.clearTabFailedPrefetches = function clearTabFailedPrefetches(tabState) {
  if (!tabState?.segments?.length) return
  for (const url of tabState.segments) {
    const normalized = typeof ns.normalizePrefetchUrl === "function" ? ns.normalizePrefetchUrl(url) : url
    if (!normalized) continue
    state.failedPrefetches.delete(normalized)
    if (typeof ns.tryReleaseInflightEntry === "function") {
      ns.tryReleaseInflightEntry(normalized, { logPreserve: false })
    } else {
      state.inflightPrefetches.delete(normalized)
    }
  }
}

ns.getTabRefreshState = function getTabRefreshState(tabId) {
  return state.playlistByTab.get(tabId)?.refreshState || ns.REFRESH_STATE_HEALTHY
}

ns.formatTabStateLabel = function formatTabStateLabel(tabState) {
  const stateName = tabState?.refreshState || ns.REFRESH_STATE_HEALTHY
  switch (stateName) {
    case ns.REFRESH_STATE_REFRESHING: {
      const gen = Number(tabState.pendingManifestGeneration) || Number(tabState.manifestGeneration) || 0
      return gen > 0 ? `Refreshing (gen ${gen})` : "Refreshing"
    }
    case ns.REFRESH_STATE_RECOVERING: {
      const done = Number(tabState.refreshRecoverySuccessCount || 0)
      const target = Number(constants.REFRESH_RECOVERY_SUCCESS_TARGET) || 3
      return `Recovering (warmup ${done}/${target})`
    }
    case ns.REFRESH_STATE_AUTH_EXPIRED:
      return "Auth expired"
    case ns.REFRESH_STATE_HEALTHY:
    default:
      return "Healthy"
  }
}

ns.logTabState = function logTabState(tabId, tabState, reason, level = "INFO") {
  const label = ns.formatTabStateLabel(tabState)
  const suffix = reason ? ` — ${reason}` : ""
  ns.addLog(level, `STATE: ${label} (tab ${tabId})${suffix}`)
}
})()
