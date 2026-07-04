(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

function snapshotAnchorBeforeRefresh(tabState) {
  if (!tabState?.hasAnchor || typeof tabState.anchorIndex !== "number") return
  tabState.lastAnchorBeforeRefresh = tabState.anchorIndex
  if (typeof tabState.mediaSequence === "number") tabState.lastAnchorMediaSequenceBeforeRefresh = tabState.mediaSequence + tabState.anchorIndex
}

function clearManifestRefreshRetryTimer(tabState) {
  if (!tabState?.refreshRetryTimer) return
  clearTimeout(tabState.refreshRetryTimer)
  tabState.refreshRetryTimer = null
}

function clearManifestRefreshTimeout(tabState) {
  if (!tabState?.manifestRefreshTimer) return
  clearTimeout(tabState.manifestRefreshTimer)
  tabState.manifestRefreshTimer = null
}

function scheduleRefreshRetry(tabId, tabState, reason) {
  if (!tabState || tabState.refreshState !== ns.REFRESH_STATE_REFRESHING) return
  clearManifestRefreshRetryTimer(tabState)
  const attempt = Number(tabState.refreshRetryAttempt || 0) + 1
  tabState.refreshRetryAttempt = attempt
  const maxRetries = Math.max(1, Number(constants.MANIFEST_REFRESH_MAX_RETRIES) || 5)

  if (attempt > maxRetries) {
    ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_AUTH_EXPIRED, "retries exhausted")
    addLog("WARN", `Soft recovery failed on tab ${tabId} — page authentication may have expired. Playback may resume if the player refreshes its manifest; reload only if it stays broken.`)
    return
  }

  const delayMs = ns.computeRefreshRetryDelayMs(attempt)
  addLog("DEBUG", `Manifest refresh retry #${attempt}/${maxRetries} on tab ${tabId} in ${Math.round(delayMs / 1000)}s (${reason})`)
  tabState.refreshRetryTimer = setTimeout(() => {
    tabState.refreshRetryTimer = null
    void ns.executeManifestRefreshAttempt(tabId, reason)
  }, delayMs)
}

function scheduleManifestRefreshTimeout(tabId, tabState) {
  if (!tabState) return
  clearManifestRefreshTimeout(tabState)
  const timeoutMs = ns.getManifestRefreshTimeoutMs(tabState)
  tabState.manifestRefreshTimer = setTimeout(() => {
    tabState.manifestRefreshTimer = null
    if (tabState.refreshState !== ns.REFRESH_STATE_REFRESHING) return
    addLog("WARN", `Manifest refresh timed out on tab ${tabId} after ${Math.round(timeoutMs / 1000)}s — scheduling retry`)
    scheduleRefreshRetry(tabId, tabState, "timeout")
  }, timeoutMs)
}

async function delegatePlaylistRefreshToPage(tabId, playlistUrl, generation) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "AegisStream:RefreshPlaylist", url: playlistUrl, generation })
    return true
  } catch (e) {
    addLog("WARN", `Page playlist refresh delegate failed on tab ${tabId}: ${e.message}`)
    return false
  }
}

ns.transitionRefreshState = function transitionRefreshState(tabId, tabState, newState, reason) {
  if (!tabState) return
  const previous = tabState.refreshState || ns.REFRESH_STATE_HEALTHY
  if (previous === newState) return
  tabState.refreshState = newState
  tabState.manifestRefreshPending = newState === ns.REFRESH_STATE_REFRESHING

  if (newState === ns.REFRESH_STATE_HEALTHY) {
    tabState.prefetchPausedUntil = 0
    if (typeof ns.clearRefreshRecovery === "function") ns.clearRefreshRecovery(tabState)
    else { tabState.refreshRecoveryUntil = 0; tabState.refreshRecoverySuccessCount = 0 }
    tabState.refreshRetryAttempt = 0
    clearManifestRefreshTimeout(tabState)
    clearManifestRefreshRetryTimer(tabState)
  } else if (newState === ns.REFRESH_STATE_REFRESHING) {
    tabState.prefetchPausedUntil = Date.now() + constants.PREFETCH_PAUSE_AFTER_REFRESH_MS
  } else if (newState === ns.REFRESH_STATE_RECOVERING) {
    tabState.prefetchPausedUntil = 0
    tabState.manifestRefreshPending = false
    clearManifestRefreshTimeout(tabState)
    clearManifestRefreshRetryTimer(tabState)
    tabState.refreshRetryAttempt = 0
    if (typeof ns.beginRefreshRecovery === "function") ns.beginRefreshRecovery(tabState)
    else {
      tabState.refreshRecoveryUntil = Date.now() + constants.REFRESH_RECOVERY_MAX_MS
      tabState.refreshRecoverySuccessCount = 0
    }
  } else if (newState === ns.REFRESH_STATE_AUTH_EXPIRED) {
    tabState.manifestRefreshPending = false
    tabState.prefetchPausedUntil = Date.now() + constants.AUTH_EXPIRED_RETRY_COOLDOWN_MS
    clearManifestRefreshTimeout(tabState)
    clearManifestRefreshRetryTimer(tabState)
  }

  ns.logTabState(tabId, tabState, reason)
}
ns.transitionTabRefreshState = ns.transitionRefreshState

ns.bumpManifestGeneration = function bumpManifestGeneration(tabState) {
  const next = (Number(tabState.manifestGeneration) || 0) + 1
  tabState.manifestGeneration = next
  tabState.pendingManifestGeneration = next
  return next
}

ns.abortManifestRefreshForEpisode = function abortManifestRefreshForEpisode(tabId, tabState, reason) {
  if (!tabState) return
  clearManifestRefreshTimeout(tabState)
  clearManifestRefreshRetryTimer(tabState)
  tabState.manifestRefreshPending = false
  tabState.prefetchPausedUntil = 0
  tabState.prefetchFailureWindow = null
  tabState.refreshRetryAttempt = 0
  if (typeof ns.resetPrefetchFailureStreak === "function") ns.resetPrefetchFailureStreak(tabState)
  if (tabState.refreshState === ns.REFRESH_STATE_REFRESHING) ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_HEALTHY, reason)
}

ns.executeManifestRefreshAttempt = async function executeManifestRefreshAttempt(tabId, reason) {
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.mediaPlaylistUrl) return false
  if (tabState.refreshState !== ns.REFRESH_STATE_REFRESHING) ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_REFRESHING, reason)

  snapshotAnchorBeforeRefresh(tabState)
  const generation = ns.bumpManifestGeneration(tabState)
  tabState.lastManifestRefreshAt = Date.now()

  ns.cancelPendingPrefetchForTab(tabId)
  ns.releaseInflightForTab(tabId)
  clearManifestRefreshTimeout(tabState)

  const playlistUrl = tabState.mediaPlaylistUrl
  const inEpisodeGrace = ns.isInEpisodeTransitionGrace(tabState)
  addLog("INFO", `Manifest refresh attempt (${reason}, gen ${generation}, tab ${tabId}): target=${typeof ns.formatPlaylistUrlTail === "function" ? ns.formatPlaylistUrlTail(playlistUrl) : playlistUrl?.slice(-96)}${inEpisodeGrace ? ", episodeGrace=active" : ""}`)
  if (typeof ns.recordManifestRefreshStart === "function") ns.recordManifestRefreshStart(tabId)

  scheduleManifestRefreshTimeout(tabId, tabState)
  const delegated = await delegatePlaylistRefreshToPage(tabId, playlistUrl, generation)
  const pageFirstMs = Math.max(0, Number(constants.MANIFEST_REFRESH_PAGE_FIRST_MS) || 300)
  const backgroundFallbackMs = delegated ? Math.max(pageFirstMs, Number(constants.MANIFEST_REFRESH_BACKGROUND_FALLBACK_MS) || 2_500) : pageFirstMs
  const refreshStartedAt = Number(tabState.lastManifestRefreshAt || Date.now())
  setTimeout(() => {
    const latest = state.playlistByTab.get(tabId)
    if (delegated && latest) {
      const alreadyCaptured = Number(latest.playlistRefreshedAt || 0) >= refreshStartedAt || Number(latest.tokensRefreshedAt || 0) >= refreshStartedAt || latest.refreshState === ns.REFRESH_STATE_RECOVERING || latest.refreshState === ns.REFRESH_STATE_HEALTHY
      const generationMoved = Number(latest.pendingManifestGeneration || 0) > 0 && Number(latest.pendingManifestGeneration || 0) !== generation
      if (alreadyCaptured || generationMoved) return
    }
    void ns.parseAndPrefetchFromPlaylist(tabId, playlistUrl, 0)
  }, backgroundFallbackMs)
  if (!delegated) scheduleRefreshRetry(tabId, tabState, "delegate-failed")
  return delegated
}

ns.noteManifestRefreshFailed = function noteManifestRefreshFailed(tabId, generation, status) {
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState || tabState.refreshState !== ns.REFRESH_STATE_REFRESHING) return
  const pendingGen = Number(tabState.pendingManifestGeneration) || 0
  const msgGen = Number(generation)
  if (pendingGen > 0 && Number.isFinite(msgGen) && msgGen !== pendingGen) return
  const statusLabel = Number.isFinite(Number(status)) ? `HTTP ${status}` : "fetch failed"
  scheduleRefreshRetry(tabId, tabState, statusLabel)
}

ns.shouldAcceptPlaylistCapture = function shouldAcceptPlaylistCapture(tabState, generation, urlsChanged = false) {
  if (!tabState) return true
  const msgGen = Number(generation)
  const currentGen = Number(tabState.manifestGeneration) || 0
  const refreshing = ns.isRefreshActive(tabState)
  if (Number.isFinite(msgGen) && msgGen > 0) {
    if (msgGen < currentGen) return false
    if (refreshing) return msgGen === Number(tabState.pendingManifestGeneration)
    return true
  }
  if (refreshing) return urlsChanged === true
  return true
}

ns.finishManifestRefreshIfPending = function finishManifestRefreshIfPending(tabId, tabState, urlsChanged, generation) {
  if (!urlsChanged) return false
  const refreshing = tabState?.refreshState === ns.REFRESH_STATE_REFRESHING || tabState?.manifestRefreshPending === true
  if (!refreshing) return false

  const msgGen = Number(generation)
  const pendingGen = Number(tabState.pendingManifestGeneration) || 0
  if (pendingGen > 0 && Number.isFinite(msgGen) && msgGen > 0 && msgGen !== pendingGen) return false

  const anchorLabel = tabState.hasAnchor && typeof tabState.anchorIndex === "number" ? `, anchor ${tabState.anchorIndex}` : ""
  const healReason = pendingGen > 0 ? `manifest healed gen ${pendingGen}${anchorLabel}` : `manifest healed piggyback${anchorLabel}`

  ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_RECOVERING, healReason)
  if (typeof ns.recordManifestRefreshComplete === "function") ns.recordManifestRefreshComplete(tabId)
  tabState.anchorRetainedByRefresh = false
  if (typeof ns.clearTabFailedPrefetches === "function") ns.clearTabFailedPrefetches(tabState)
  if (typeof ns.resetPrefetchFailureStreak === "function") ns.resetPrefetchFailureStreak(tabState)
  tabState.prefetchFailureWindow = null
  tabState.lastScheduledFromIndex = -1
  if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
    ns.maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "manifest-refresh")
  }
  return true
}

ns.requestManifestRefreshForTab = async function requestManifestRefreshForTab(tabId, reason) {
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.mediaPlaylistUrl) return false
  if (ns.isTabInScrubbingTrain(tabState) || ns.wasRecentlyScrubbing(tabState)) {
    addLog("DEBUG", `Skipping manifest refresh (${reason}) on tab ${tabId} — scrubbing train active`)
    return false
  }
  const now = Date.now()
  const reentrant = tabState.refreshState === ns.REFRESH_STATE_REFRESHING
  if (tabState.refreshState === ns.REFRESH_STATE_AUTH_EXPIRED && now - Number(tabState.lastManifestRefreshAt || 0) < constants.AUTH_EXPIRED_RETRY_COOLDOWN_MS) return false
  if (!reentrant && tabState.refreshState !== ns.REFRESH_STATE_AUTH_EXPIRED && now - Number(tabState.lastManifestRefreshAt || 0) < constants.MANIFEST_REFRESH_DEBOUNCE_MS) return false

  if (tabState.refreshState === ns.REFRESH_STATE_AUTH_EXPIRED) ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_HEALTHY, "auth-expired-retry")
  if (!reentrant) ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_REFRESHING, reason)
  else addLog("DEBUG", `Manifest refresh re-entrant (${reason}) on tab ${tabId}`)

  return ns.executeManifestRefreshAttempt(tabId, reason)
}

ns.rememberMediaPlaylistUrl = function rememberMediaPlaylistUrl(tabState, playlistUrl, tabId = null) {
  if (!tabState || typeof playlistUrl !== "string" || !playlistUrl) return
  const prior = tabState.mediaPlaylistUrl ? (typeof ns.stripHash === "function" ? ns.stripHash(tabState.mediaPlaylistUrl) : tabState.mediaPlaylistUrl) : null
  const normalized = typeof ns.stripHash === "function" ? ns.stripHash(playlistUrl) : playlistUrl
  if (!normalized) return
  tabState.mediaPlaylistUrl = normalized
  tabState.lastMediaPlaylistUrl = normalized
  if (ns.isInEpisodeTransitionGrace(tabState) && prior !== normalized) {
    const tabLabel = Number.isFinite(tabId) ? `tab ${tabId}` : "tab ?"
    addLog("INFO", `Episode playlist resolved (${tabLabel}): refreshTarget=${typeof ns.formatPlaylistUrlTail === "function" ? ns.formatPlaylistUrlTail(normalized) : normalized.slice(-96)}`)
  }
}

ns.classifyPrefetchError = function classifyPrefetchError(errorText, authFailure, tabState, options = {}) {
  if (options.rateLimit === true) return "rateLimit"
  if (authFailure === true) return "auth"
  const httpStatus = Number(options.httpStatus) || 0
  if (httpStatus === 401 || httpStatus === 403) return "auth"
  if (httpStatus === 429) return "rateLimit"
  const text = String(errorText || "")
  if (/HTTP 429|\b429\b|too many requests|rate limit/i.test(text)) return "rateLimit"
  if (/HTTP 403|HTTP 401|403 forbidden|401 unauthorized|token|expired|signature|auth/i.test(text)) return "auth"
  if (/failed to fetch/i.test(text) && tabState?.mediaPlaylistUrl && !ns.isInEpisodeTransitionGrace(tabState)) return "maybeAuth"
  return "other"
}

ns.resetPrefetchFailureStreak = function resetPrefetchFailureStreak(tabState) {
  if (!tabState?.prefetchFailureWindow) return
  tabState.prefetchFailureWindow.consecutiveAuth = 0
  tabState.prefetchFailureWindow.consecutiveMaybeAuth = 0
}

ns.noteTabPrefetchSuccess = function noteTabPrefetchSuccess(tabId) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  ns.resetPrefetchFailureStreak(tabState)
  if (typeof ns.recordFirstSuccessfulSegment === "function") ns.recordFirstSuccessfulSegment(tabId)
}

ns.noteTabPrefetchFailure = function noteTabPrefetchFailure(tabId, errorText, options = {}) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState || ns.isRefreshActive(tabState)) return

  const now = Date.now()
  const windowMs = constants.PREFETCH_AUTH_FAILURE_WINDOW_MS
  if (!tabState.prefetchFailureWindow || now - tabState.prefetchFailureWindow.startedAt > windowMs) {
    tabState.prefetchFailureWindow = { count: 0, authCount: 0, maybeAuthCount: 0, consecutiveAuth: 0, consecutiveMaybeAuth: 0, startedAt: now }
  }
  const w = tabState.prefetchFailureWindow
  w.count += 1
  const kind = ns.classifyPrefetchError(errorText, options.authFailure, tabState, options)

  if (kind === "auth") { w.authCount += 1; w.consecutiveAuth = Number(w.consecutiveAuth || 0) + 1; w.consecutiveMaybeAuth = 0 }
  else if (kind === "maybeAuth") { w.maybeAuthCount += 1; w.consecutiveMaybeAuth = Number(w.consecutiveMaybeAuth || 0) + 1; w.consecutiveAuth = 0 }
  else if (kind === "rateLimit") {
    ns.resetPrefetchFailureStreak(tabState)
    tabState.prefetchPausedUntil = Date.now() + constants.PREFETCH_RATE_LIMIT_PAUSE_MS
    addLog("WARN", `CDN rate limit on tab ${tabId} — pausing prefetch for ${Math.round(constants.PREFETCH_RATE_LIMIT_PAUSE_MS / 1000)}s`)
    return
  } else { ns.resetPrefetchFailureStreak(tabState) }

  const authThreshold = Math.max(2, Number(constants.PREFETCH_AUTH_FAILURE_THRESHOLD) || 3)
  const maybeThreshold = Number(constants.PREFETCH_CONSECUTIVE_MAYBE_AUTH_THRESHOLD) || Number(constants.PREFETCH_NETWORK_MAYBE_AUTH_THRESHOLD) || 6
  const maybeWithAuth = Number(constants.PREFETCH_CONSECUTIVE_MAYBE_WITH_AUTH) || Number(constants.PREFETCH_NETWORK_MAYBE_AUTH_WITH_AUTH) || 4
  const shouldRefresh = w.consecutiveAuth >= authThreshold || (w.consecutiveAuth >= 1 && w.consecutiveMaybeAuth >= maybeWithAuth) || (tabState.mediaPlaylistUrl && w.consecutiveMaybeAuth >= maybeThreshold)

  if (shouldRefresh) {
    if (ns.isInEpisodeTransitionGrace(tabState, now)) {
      addLog("DEBUG", `Skipping manifest refresh for prefetch-auth-failures on tab ${tabId} — episode transition grace active`)
      tabState.prefetchFailureWindow = null
      return
    }
    tabState.prefetchFailureWindow = null
    void ns.requestManifestRefreshForTab(tabId, "prefetch-auth-failures")
  }
}

ns.isTeleportModePrefetchSource = function isTeleportModePrefetchSource(source = "") {
  const clean = typeof ns.normalizeLifecycleEventSource === "function" ? ns.normalizeLifecycleEventSource(source)
    : String(source || "").replace(/^delegate-/, "").toLowerCase().trim()
  return clean === "teleport-mode" || clean === "teleport-mode-retained"
}

ns.shouldAbortDelegatedBeforeSend = function shouldAbortDelegatedBeforeSend(tabState, source = "") {
  if (!tabState) return false
  if (typeof ns.isNonDestructiveLifecycleSource === "function" && ns.isNonDestructiveLifecycleSource(source)) return false
  if (typeof ns.isSoftScrubDelegateSource === "function" && ns.isSoftScrubDelegateSource(source, tabState)) return false

  const now = Date.now()
  const teleportPrefetch = ns.isTeleportModePrefetchSource(source)
  if (teleportPrefetch && now < Number(tabState.teleportModeUntil || 0)) return false
  if (now < Number(tabState.scrubbingTrainUntil || 0)) return !teleportPrefetch
  if (now < Number(tabState.seekChurnAggressiveUntil || 0)) return !teleportPrefetch
  if (now < Number(tabState.teleportModeUntil || 0)) return !teleportPrefetch
  return /scrub|velocity|teleport|snap|churn/i.test(String(source || ""))
}
})()
