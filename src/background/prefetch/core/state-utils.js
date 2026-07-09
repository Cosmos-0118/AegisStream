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

ns.getOrCreateTabSession = function getOrCreateTabSession(tabId) {
  if (!Number.isFinite(tabId)) return null
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState) return null
  if (!tabState.playbackSession) {
    tabState.playbackSession = {
      id: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stableAt: 0,
      episodeChangedAt: 0,
      state: "NEW",
      bufferWindowStart: 0,
      bufferWindowSize: 0,
      anchorIndex: null,
      lastCompositeKey: null,
      lastTimelineHash: null,
      lastPlaylistPath: null,
      lastPageUrl: null
    }
  }
  return tabState.playbackSession
}

ns.updateTabSession = function updateTabSession(tabId, patch = {}) {
  const session = ns.getOrCreateTabSession(tabId)
  if (!session) return null
  Object.assign(session, patch, { updatedAt: Date.now() })
  return session
}

ns.markSessionStable = function markSessionStable(tabId, session) {
  if (!session) return
  session.state = "STABLE"
  session.stableAt = Date.now()
  session.updatedAt = Date.now()
  if (Number.isFinite(tabId) && typeof ns.addLog === "function") {
    ns.addLog("DEBUG", `Session stabilized on tab ${tabId} (anchor=${session.anchorIndex ?? "n/a"}, window=${session.bufferWindowStart}-${(session.bufferWindowStart || 0) + (session.bufferWindowSize || 0)})`)
  }
}

ns.markSessionEpisodeSwitch = function markSessionEpisodeSwitch(tabId, session) {
  if (!session) return
  session.state = "EPISODE_SWITCHED"
  session.episodeChangedAt = Date.now()
  session.stableAt = 0
  session.updatedAt = Date.now()
  if (Number.isFinite(tabId) && typeof ns.addLog === "function") {
    ns.addLog("INFO", `Session episode switch on tab ${tabId} (new composite identity)`)
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
