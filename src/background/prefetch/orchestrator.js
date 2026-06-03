(() => {
var ns = (self.AegisBackground ||= {})
const {
  constants,
  state,
  addLog,
  stripHash,
  buildCacheKeyVariants,
  normalizeSegments,
  parseHlsPlaylist,
  parseDashPlaylist,
  extractStartSecondsFromPageUrl,
  resolveCachedChunk,
  bumpActivity,
  isTabEligibleForPrefetch,
  isTabInAnchorCooldown,
  applyAnchorJumpCooldown,
  cancelPendingPrefetchForTab,
  releaseInflightForTab,
  countGlobalInflightPrefetches,
  resolveBufferAdjustedPrefetchWindow,
  resolveBufferAdjustedGlobalCap,
  getTabBufferTier,
  isReactivePrefetchTab,
  isTwitchMediaUrl,
  noteTabPageUrl,
  getTabPageUrlFingerprint,
  getManifestUrlSignature,
  buildManifestSequenceIndex,
  buildPlaylistFingerprint,
  buildStructuralPlaylistHash,
  scorePlaylistFingerprintChange,
  resolveSegmentIndexInManifest,
  determinePlaybackTransition,
  PlaybackStates,
  estimateManifestIndexFromTime
} = ns

const TIER_EMERGENCY = "emergency"
const TIER_AGGRESSIVE = "aggressive"

const REFRESH_STATE_HEALTHY = "healthy"
const REFRESH_STATE_REFRESHING = "refreshing"
const REFRESH_STATE_RECOVERING = "recovering"
const REFRESH_STATE_AUTH_EXPIRED = "auth_expired"

const chunkObservedDebounceAt = new Map()
const playlistFetchInFlight = new Set()
const playlistFetchCompletedAt = new Map()

function pruneChunkObservedDebounce(now = Date.now()) {
  const cutoff = now - constants.CHUNK_OBSERVED_DEBOUNCE_MS * 4
  for (const [key, ts] of chunkObservedDebounceAt.entries()) {
    if (ts < cutoff) chunkObservedDebounceAt.delete(key)
  }
}

function shouldCountChunkObserved(tabId, chunkUrl) {
  const key = `${tabId}:${chunkUrl}`
  const now = Date.now()
  const last = chunkObservedDebounceAt.get(key) || 0
  if (now - last < constants.CHUNK_OBSERVED_DEBOUNCE_MS) return false
  chunkObservedDebounceAt.set(key, now)
  pruneChunkObservedDebounce(now)
  return true
}

function isTabInRapidSeek(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.rapidSeekUntil || 0)
}

function isTabInSeekChurnAggressive(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.seekChurnAggressiveUntil || 0)
}

function isTabInTeleportMode(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.teleportModeUntil || 0)
}

function markSeekChurnAggressive(tabState) {
  if (!tabState) return
  const now = Date.now()
  tabState.seekChurnAggressiveUntil = now + constants.SEEK_CHURN_AGGRESSIVE_MS
  tabState.highChurnMode = true
  tabState.rapidSeekUntil = 0
}

function softCommitAnchor(tabId, tabState, targetIndex, source = "anchor-soft-commit") {
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return
  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))
  const previousAnchor = tabState.anchorIndex

  if (typeof ns.resetPassiveAnchorDeferral === "function") {
    ns.resetPassiveAnchorDeferral(tabState)
  } else {
    tabState.anchorPendingIndex = null
    tabState.anchorPendingCount = 0
    tabState.anchorLockStartedAt = 0
  }

  markSeekChurnAggressive(tabState)
  tabState.hasAnchor = true
  tabState.anchorIndex = clampedTarget
  tabState.anchorRetainedByRefresh = false
  tabState.lastScheduledFromIndex = -1
  if (typeof tabState.mediaSequence === "number") {
    tabState.anchorMediaSequence = tabState.mediaSequence + clampedTarget
  }

  addLog(
    "INFO",
    `Soft anchor commit on tab ${tabId} (${source}): ${previousAnchor ?? "?"} -> ${clampedTarget}, retaining prefetch overlap`
  )
  void schedulePrefetch(tabId, tabState.segments, Math.max(0, clampedTarget - 1), {
    force: true,
    source
  })
}

function commitAnchorFromAuthority(tabId, targetIndex, authority, source = "anchor-authority") {
  if (!Number.isFinite(tabId)) return false
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return false

  const evaluate =
    typeof ns.evaluateAuthorityCommit === "function" ? ns.evaluateAuthorityCommit : null
  const decision = evaluate
    ? evaluate(tabState, targetIndex, authority)
    : { allow: true, reason: null, jump: anchorJumpForTab(tabState, targetIndex), purgeQueues: true }

  if (!decision.allow) {
    if (authority === ns.AnchorAuthority?.DOM_SEEKED && typeof ns.recordDomSeekSkipped === "function") {
      ns.recordDomSeekSkipped()
    }
    addLog(
      "DEBUG",
      `Anchor authority commit skipped on tab ${tabId} (${typeof ns.authorityLabel === "function" ? ns.authorityLabel(authority) : authority}, ${decision.reason || "denied"}, jump=${decision.jump ?? "?"})`
    )
    return false
  }

  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))
  const oldAnchor = tabState.hasAnchor ? tabState.anchorIndex : null
  if (authority === ns.AnchorAuthority?.DOM_SEEKED) {
    tabState.lastDomTeleportAt = Date.now()
  }

  if (typeof ns.resetPassiveAnchorDeferral === "function") {
    ns.resetPassiveAnchorDeferral(tabState)
  } else {
    tabState.anchorPendingIndex = null
    tabState.anchorPendingCount = 0
    tabState.anchorLockStartedAt = 0
  }

  const label =
    typeof ns.authorityLabel === "function" ? ns.authorityLabel(authority) : String(authority)
  addLog(
    "INFO",
    `Anchor authority commit on tab ${tabId} (${label}, ${source}): ${oldAnchor ?? "?"} -> ${clampedTarget}, purgeQueues=${decision.purgeQueues === true}`
  )

  if (typeof ns.recordAnchorCommit === "function") {
    ns.recordAnchorCommit(authority, {
      teleport: decision.purgeQueues === true ? "hard" : "soft"
    })
  }

  if (decision.purgeQueues === true) {
    enterTeleportMode(tabId, tabState, clampedTarget, source, { purgeQueues: true })
  } else {
    softCommitAnchor(tabId, tabState, clampedTarget, source)
  }
  return true
}

function anchorJumpForTab(tabState, targetIndex) {
  const current = tabState?.hasAnchor ? tabState.anchorIndex : null
  if (typeof current !== "number" || typeof targetIndex !== "number") return Number.POSITIVE_INFINITY
  return Math.abs(targetIndex - current)
}

function handleForceTeleportAnchor(tabId, payload = {}) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length) return

  let targetIndex = Number(payload.index)
  if (!Number.isFinite(targetIndex) && Number.isFinite(Number(payload.currentTimeSec))) {
    targetIndex = estimateManifestIndexFromTime(Number(payload.currentTimeSec), tabState.segmentDurations, {
      totalDurationSec: tabState.playlistFingerprint?.totalDuration,
      segmentCount: tabState.segments.length,
      fallbackSegmentDurationSec: 4
    })
  }
  if (!Number.isFinite(targetIndex)) return
  const authority = ns.AnchorAuthority?.DOM_SEEKED ?? 3
  commitAnchorFromAuthority(tabId, targetIndex, authority, payload.source || "dom-seeked")
}

function enterTeleportMode(tabId, tabState, targetIndex, source = "teleport", options = {}) {
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return
  const now = Date.now()
  const radius = Math.max(1, Number(constants.TELEPORT_MODE_RADIUS) || 5)
  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))
  const start = Math.max(0, clampedTarget - radius)
  const previousAnchor = tabState.anchorIndex
  const jump = anchorJumpForTab(tabState, clampedTarget)
  const purgeQueues =
    options.purgeQueues !== false &&
    (options.purgeQueues === true ||
      (typeof ns.shouldPurgePrefetchQueues === "function"
        ? ns.shouldPurgePrefetchQueues(jump)
        : jump >= (Number(constants.TELEPORT_QUEUE_PURGE_THRESHOLD) || 20)))

  tabState.teleportModeUntil = now + constants.TELEPORT_MODE_DURATION_MS
  tabState.teleportTargetIndex = clampedTarget
  markSeekChurnAggressive(tabState)
  tabState.hasAnchor = true
  tabState.anchorIndex = clampedTarget
  tabState.anchorRetainedByRefresh = false
  tabState.lastScheduledFromIndex = -1
  if (typeof tabState.mediaSequence === "number") {
    tabState.anchorMediaSequence = tabState.mediaSequence + clampedTarget
  }

  if (purgeQueues) {
    cancelPendingPrefetchForTab(tabId)
    releaseInflightForTab(tabId)
    try {
      chrome.tabs.sendMessage(tabId, { type: "AegisStream:CancelPrefetch" })
    } catch {
      // tab may not be ready
    }
  }

  addLog(
    "INFO",
    `Teleport mode activated on tab ${tabId} (${source}): anchor=${clampedTarget}/${tabState.segments.length - 1}, prefetching target ring ${start}-${Math.min(tabState.segments.length - 1, clampedTarget + radius)}${purgeQueues ? "" : ", queues retained"}`
  )
  if (typeof ns.recordSeekPrediction === "function") {
    ns.recordSeekPrediction(tabId, {
      predictedIndex: clampedTarget,
      currentTimeSec: null,
      previousIndex: previousAnchor,
      teleport: true,
      source
    })
  }

  void schedulePrefetch(tabId, tabState.segments, start, {
    force: true,
    source: "teleport-mode"
  })
  if (typeof ns.maybeScheduleSpeculativePrefetch === "function") {
    ns.maybeScheduleSpeculativePrefetch(tabId)
  }
}

function handleSeekPrediction(tabId, currentTimeSec) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length) return

  const estimatedIndex = estimateManifestIndexFromTime(currentTimeSec, tabState.segmentDurations, {
    totalDurationSec: tabState.playlistFingerprint?.totalDuration,
    segmentCount: tabState.segments.length,
    fallbackSegmentDurationSec: 4
  })
  if (typeof estimatedIndex !== "number") return

  tabState.predictedAnchorIndex = estimatedIndex
  tabState.predictedAnchorAt = Date.now()

  const previousIndex = tabState.hasAnchor ? tabState.anchorIndex : null
  if (typeof ns.recordSeekPrediction === "function") {
    ns.recordSeekPrediction(tabId, {
      predictedIndex: estimatedIndex,
      currentTimeSec,
      previousIndex,
      teleport: false,
      source: "seek-prediction"
    })
  }
  const teleportThreshold = Number(constants.TELEPORT_MODE_JUMP_THRESHOLD) || 20

  if (typeof previousIndex === "number") {
    const jump = Math.abs(estimatedIndex - previousIndex)
    if (jump >= teleportThreshold) {
      const authority = ns.AnchorAuthority?.SEEK_PREDICTION ?? 2
      commitAnchorFromAuthority(tabId, estimatedIndex, authority, "seek-prediction")
      return
    }
    if (jump > 1) {
      markSeekChurnAggressive(tabState)
      tabState.anchorIndex = estimatedIndex
      if (typeof tabState.mediaSequence === "number") {
        tabState.anchorMediaSequence = tabState.mediaSequence + estimatedIndex
      }
      void schedulePrefetch(tabId, tabState.segments, Math.max(0, estimatedIndex - 1), {
        force: true,
        source: "seek-prediction"
      })
    }
    return
  }

  tabState.hasAnchor = true
  tabState.anchorIndex = estimatedIndex
  if (typeof tabState.mediaSequence === "number") {
    tabState.anchorMediaSequence = tabState.mediaSequence + estimatedIndex
  }
  void schedulePrefetch(tabId, tabState.segments, Math.max(0, estimatedIndex), {
    force: true,
    source: "seek-prediction"
  })
}

function noteAnchorChange(tabState, previousIndex, nextIndex) {
  if (typeof previousIndex !== "number" || typeof nextIndex !== "number") return
  if (previousIndex === nextIndex) return
  const now = Date.now()
  const recent = Array.isArray(tabState.recentAnchorChanges)
    ? tabState.recentAnchorChanges
    : []
  const compacted = recent.filter((ts) => now - ts < constants.RAPID_SEEK_WINDOW_MS)
  compacted.push(now)
  tabState.recentAnchorChanges = compacted
  if (compacted.length >= constants.RAPID_SEEK_CHANGE_THRESHOLD) {
    markSeekChurnAggressive(tabState)
  }
}

function pruneRuntimeState() {
  const now = Date.now()
  for (const [tabId, tabState] of state.playlistByTab.entries()) {
    if (now - tabState.updatedAt > constants.STALE_TAB_STATE_MS) {
      state.playlistByTab.delete(tabId)
      state.tabAnchorJumps.delete(tabId)
      state.bridgeHeartbeatByTab.delete(tabId)
      const pending = state.pendingPrefetchByTab.get(tabId)
      if (pending?.timerId) clearTimeout(pending.timerId)
      state.pendingPrefetchByTab.delete(tabId)
    }
  }
  for (const [url, failureInfo] of state.failedPrefetches.entries()) {
    const retryAfter =
      typeof failureInfo === "number" ? failureInfo : Number(failureInfo?.retryAfter || 0)
    if (retryAfter + constants.FAILURE_STATE_RETENTION_MS < now) {
      state.failedPrefetches.delete(url)
    }
  }
  for (const [url, inflight] of state.inflightPrefetches.entries()) {
    if (now - Number(inflight?.startedAt || 0) > constants.PREFETCH_INFLIGHT_TTL_MS) {
      state.inflightPrefetches.delete(url)
    }
  }
}

function normalizePrefetchUrl(url) {
  return stripHash(url)
}

function clearPrefetchTrackingForUrls(urls) {
  if (!Array.isArray(urls)) return
  for (const url of urls) {
    const normalized = normalizePrefetchUrl(url)
    if (!normalized) continue
    state.inflightPrefetches.delete(normalized)
    state.failedPrefetches.delete(normalized)
  }
}

function classifyPrefetchError(errorText, authFailure, tabState, options = {}) {
  if (options.rateLimit === true) return "rateLimit"
  if (authFailure === true) return "auth"
  const text = String(errorText || "")
  if (/HTTP 429|\b429\b|too many requests|rate limit/i.test(text)) return "rateLimit"
  if (/HTTP 403|HTTP 401|403 forbidden|401 unauthorized|token|expired|signature|auth/i.test(text)) {
    return "auth"
  }
  if (/failed to fetch/i.test(text) && tabState?.mediaPlaylistUrl) return "maybeAuth"
  return "other"
}

function bumpManifestGeneration(tabState) {
  const next = (Number(tabState.manifestGeneration) || 0) + 1
  tabState.manifestGeneration = next
  tabState.pendingManifestGeneration = next
  return next
}

function segmentsUrlsChanged(previousSegments, nextSegments) {
  if (!Array.isArray(previousSegments) || !Array.isArray(nextSegments)) return true
  if (previousSegments.length !== nextSegments.length) return true
  return nextSegments.some((url, i) => url !== previousSegments[i])
}

function isRefreshActive(tabState) {
  const stateName = tabState?.refreshState || REFRESH_STATE_HEALTHY
  return stateName === REFRESH_STATE_REFRESHING
}

function formatTabStateLabel(tabState) {
  const stateName = tabState?.refreshState || REFRESH_STATE_HEALTHY
  switch (stateName) {
    case REFRESH_STATE_REFRESHING: {
      const gen =
        Number(tabState.pendingManifestGeneration) || Number(tabState.manifestGeneration) || 0
      return gen > 0 ? `Refreshing (gen ${gen})` : "Refreshing"
    }
    case REFRESH_STATE_RECOVERING: {
      const done = Number(tabState.refreshRecoverySuccessCount || 0)
      const target = Number(constants.REFRESH_RECOVERY_SUCCESS_TARGET) || 3
      return `Recovering (warmup ${done}/${target})`
    }
    case REFRESH_STATE_AUTH_EXPIRED:
      return "Auth expired"
    case REFRESH_STATE_HEALTHY:
    default:
      return "Healthy"
  }
}

function logTabState(tabId, tabState, reason, level = "INFO") {
  const label = formatTabStateLabel(tabState)
  const suffix = reason ? ` — ${reason}` : ""
  addLog(level, `STATE: ${label} (tab ${tabId})${suffix}`)
}

function transitionRefreshState(tabId, tabState, newState, reason) {
  if (!tabState) return
  const previous = tabState.refreshState || REFRESH_STATE_HEALTHY
  if (previous === newState) return
  tabState.refreshState = newState
  tabState.manifestRefreshPending = newState === REFRESH_STATE_REFRESHING

  if (newState === REFRESH_STATE_HEALTHY) {
    tabState.prefetchPausedUntil = 0
    clearRefreshRecovery(tabState)
    tabState.refreshRetryAttempt = 0
    clearManifestRefreshTimeout(tabState)
    clearManifestRefreshRetryTimer(tabState)
  } else if (newState === REFRESH_STATE_REFRESHING) {
    tabState.prefetchPausedUntil = Date.now() + constants.PREFETCH_PAUSE_AFTER_REFRESH_MS
  } else if (newState === REFRESH_STATE_RECOVERING) {
    tabState.prefetchPausedUntil = 0
    tabState.manifestRefreshPending = false
    clearManifestRefreshTimeout(tabState)
    clearManifestRefreshRetryTimer(tabState)
    tabState.refreshRetryAttempt = 0
    beginRefreshRecovery(tabState)
  } else if (newState === REFRESH_STATE_AUTH_EXPIRED) {
    tabState.manifestRefreshPending = false
    tabState.prefetchPausedUntil = Date.now() + constants.AUTH_EXPIRED_RETRY_COOLDOWN_MS
    clearManifestRefreshTimeout(tabState)
    clearManifestRefreshRetryTimer(tabState)
  }

  logTabState(tabId, tabState, reason)
}

function snapshotAnchorBeforeRefresh(tabState) {
  if (!tabState?.hasAnchor || typeof tabState.anchorIndex !== "number") return
  tabState.lastAnchorBeforeRefresh = tabState.anchorIndex
  if (typeof tabState.mediaSequence === "number") {
    tabState.lastAnchorMediaSequenceBeforeRefresh = tabState.mediaSequence + tabState.anchorIndex
  }
}

function clearManifestRefreshRetryTimer(tabState) {
  if (!tabState?.refreshRetryTimer) return
  clearTimeout(tabState.refreshRetryTimer)
  tabState.refreshRetryTimer = null
}

function computeRefreshRetryDelayMs(attempt) {
  const base = Math.max(500, Number(constants.MANIFEST_REFRESH_RETRY_BASE_MS) || 1_000)
  const max = Math.max(base, Number(constants.MANIFEST_REFRESH_RETRY_MAX_MS) || 8_000)
  const exponent = Math.max(0, Number(attempt) - 1)
  return Math.min(max, Math.round(base * 2 ** exponent))
}

function scheduleRefreshRetry(tabId, tabState, reason) {
  if (!tabState || tabState.refreshState !== REFRESH_STATE_REFRESHING) return
  clearManifestRefreshRetryTimer(tabState)
  const attempt = Number(tabState.refreshRetryAttempt || 0) + 1
  tabState.refreshRetryAttempt = attempt
  const maxRetries = Math.max(1, Number(constants.MANIFEST_REFRESH_MAX_RETRIES) || 5)

  if (attempt > maxRetries) {
    transitionRefreshState(tabId, tabState, REFRESH_STATE_AUTH_EXPIRED, "retries exhausted")
    addLog(
      "WARN",
      `Soft recovery failed on tab ${tabId} — page authentication may have expired. Playback may resume if the player refreshes its manifest; reload only if it stays broken.`
    )
    return
  }

  const delayMs = computeRefreshRetryDelayMs(attempt)
  addLog(
    "DEBUG",
    `Manifest refresh retry #${attempt}/${maxRetries} on tab ${tabId} in ${Math.round(delayMs / 1000)}s (${reason})`
  )
  tabState.refreshRetryTimer = setTimeout(() => {
    tabState.refreshRetryTimer = null
    void executeManifestRefreshAttempt(tabId, reason)
  }, delayMs)
}

async function executeManifestRefreshAttempt(tabId, reason) {
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.mediaPlaylistUrl) return false
  if (tabState.refreshState !== REFRESH_STATE_REFRESHING) {
    transitionRefreshState(tabId, tabState, REFRESH_STATE_REFRESHING, reason)
  }

  snapshotAnchorBeforeRefresh(tabState)
  const generation = bumpManifestGeneration(tabState)
  tabState.lastManifestRefreshAt = Date.now()

  cancelPendingPrefetchForTab(tabId)
  releaseInflightForTab(tabId)
  clearManifestRefreshTimeout(tabState)

  addLog(
    "DEBUG",
    `Manifest refresh attempt (${reason}, gen ${generation}) on tab ${tabId}`
  )

  scheduleManifestRefreshTimeout(tabId, tabState)
  const delegated = await delegatePlaylistRefreshToPage(tabId, tabState.mediaPlaylistUrl, generation)
  if (!delegated) {
    scheduleRefreshRetry(tabId, tabState, "delegate-failed")
  }
  return delegated
}

function noteManifestRefreshFailed(tabId, generation, status) {
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState || tabState.refreshState !== REFRESH_STATE_REFRESHING) return
  const pendingGen = Number(tabState.pendingManifestGeneration) || 0
  const msgGen = Number(generation)
  if (pendingGen > 0 && Number.isFinite(msgGen) && msgGen !== pendingGen) return
  const statusLabel = Number.isFinite(Number(status)) ? `HTTP ${status}` : "fetch failed"
  scheduleRefreshRetry(tabId, tabState, statusLabel)
}

function shouldAcceptPlaylistCapture(tabState, generation, urlsChanged = false) {
  if (!tabState) return true
  const msgGen = Number(generation)
  const currentGen = Number(tabState.manifestGeneration) || 0
  const refreshing = isRefreshActive(tabState)

  if (Number.isFinite(msgGen) && msgGen > 0) {
    if (msgGen < currentGen) return false
    if (refreshing) {
      return msgGen === Number(tabState.pendingManifestGeneration)
    }
    return true
  }

  if (refreshing) {
    return urlsChanged === true
  }
  return true
}

function beginRefreshRecovery(tabState) {
  if (!tabState) return
  tabState.refreshRecoveryUntil = Date.now() + constants.REFRESH_RECOVERY_MAX_MS
  tabState.refreshRecoverySuccessCount = 0
}

function clearRefreshRecovery(tabState) {
  if (!tabState) return
  tabState.refreshRecoveryUntil = 0
  tabState.refreshRecoverySuccessCount = 0
}

function isInRefreshRecovery(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.refreshRecoveryUntil || 0)
}

function noteRefreshRecoverySuccess(tabId, tabState) {
  if (!isInRefreshRecovery(tabState) && tabState?.refreshState !== REFRESH_STATE_RECOVERING) return
  tabState.refreshRecoverySuccessCount = Number(tabState.refreshRecoverySuccessCount || 0) + 1
  if (tabState.refreshRecoverySuccessCount >= constants.REFRESH_RECOVERY_SUCCESS_TARGET) {
    if (Number.isFinite(tabId)) {
      transitionRefreshState(tabId, tabState, REFRESH_STATE_HEALTHY, "warmup complete")
    } else {
      clearRefreshRecovery(tabState)
      tabState.refreshState = REFRESH_STATE_HEALTHY
      tabState.manifestRefreshPending = false
    }
  }
}

function isPrefetchBlocked(tabState) {
  if (!tabState) return false
  if (tabState.refreshState === REFRESH_STATE_REFRESHING) return true
  if (tabState.refreshState === REFRESH_STATE_AUTH_EXPIRED) return true
  if (tabState.manifestRefreshPending === true) return true
  const pausedUntil = Number(tabState.prefetchPausedUntil || 0)
  return Date.now() < pausedUntil
}

function clearManifestRefreshTimeout(tabState) {
  if (!tabState?.manifestRefreshTimer) return
  clearTimeout(tabState.manifestRefreshTimer)
  tabState.manifestRefreshTimer = null
}

function scheduleManifestRefreshTimeout(tabId, tabState) {
  if (!tabState) return
  clearManifestRefreshTimeout(tabState)
  tabState.manifestRefreshTimer = setTimeout(() => {
    tabState.manifestRefreshTimer = null
    if (tabState.refreshState !== REFRESH_STATE_REFRESHING) return
    addLog("WARN", `Manifest refresh timed out on tab ${tabId} — scheduling retry`)
    scheduleRefreshRetry(tabId, tabState, "timeout")
  }, constants.MANIFEST_REFRESH_TIMEOUT_MS)
}

function clearTabFailedPrefetches(tabState) {
  if (!tabState?.segments?.length) return
  for (const url of tabState.segments) {
    const normalized = normalizePrefetchUrl(url)
    if (!normalized) continue
    state.failedPrefetches.delete(normalized)
    state.inflightPrefetches.delete(normalized)
  }
}

async function delegatePlaylistRefreshToPage(tabId, playlistUrl, generation) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "AegisStream:RefreshPlaylist",
      url: playlistUrl,
      generation
    })
    return true
  } catch (e) {
    addLog("WARN", `Page playlist refresh delegate failed on tab ${tabId}: ${e.message}`)
    return false
  }
}

function finishManifestRefreshIfPending(tabId, tabState, urlsChanged, generation) {
  if (!urlsChanged) return false
  const refreshing =
    tabState?.refreshState === REFRESH_STATE_REFRESHING || tabState?.manifestRefreshPending === true
  if (!refreshing) return false

  const msgGen = Number(generation)
  const pendingGen = Number(tabState.pendingManifestGeneration) || 0
  if (pendingGen > 0 && Number.isFinite(msgGen) && msgGen > 0 && msgGen !== pendingGen) {
    return false
  }

  const anchorLabel =
    tabState.hasAnchor && typeof tabState.anchorIndex === "number"
      ? `, anchor ${tabState.anchorIndex}`
      : ""
  const healReason =
    pendingGen > 0
      ? `manifest healed gen ${pendingGen}${anchorLabel}`
      : `manifest healed piggyback${anchorLabel}`

  transitionRefreshState(tabId, tabState, REFRESH_STATE_RECOVERING, healReason)
  tabState.anchorRetainedByRefresh = false
  clearTabFailedPrefetches(tabState)
  resetPrefetchFailureStreak(tabState)
  tabState.prefetchFailureWindow = null
  tabState.lastScheduledFromIndex = -1
  if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
    maybeRequestPrefetchForTab(
      tabId,
      tabState.segments,
      tabState.anchorIndex + 1,
      "manifest-refresh"
    )
  }
  return true
}

async function requestManifestRefreshForTab(tabId, reason) {
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.mediaPlaylistUrl) return false
  const now = Date.now()
  const reentrant = tabState.refreshState === REFRESH_STATE_REFRESHING
  if (
    tabState.refreshState === REFRESH_STATE_AUTH_EXPIRED &&
    now - Number(tabState.lastManifestRefreshAt || 0) < constants.AUTH_EXPIRED_RETRY_COOLDOWN_MS
  ) {
    return false
  }
  if (
    !reentrant &&
    tabState.refreshState !== REFRESH_STATE_AUTH_EXPIRED &&
    now - Number(tabState.lastManifestRefreshAt || 0) < constants.MANIFEST_REFRESH_DEBOUNCE_MS
  ) {
    return false
  }

  if (tabState.refreshState === REFRESH_STATE_AUTH_EXPIRED) {
    transitionRefreshState(tabId, tabState, REFRESH_STATE_HEALTHY, "auth-expired-retry")
  }
  if (!reentrant) {
    transitionRefreshState(tabId, tabState, REFRESH_STATE_REFRESHING, reason)
  } else {
    addLog("DEBUG", `Manifest refresh re-entrant (${reason}) on tab ${tabId}`)
  }

  return executeManifestRefreshAttempt(tabId, reason)
}

function resetPrefetchFailureStreak(tabState) {
  if (!tabState?.prefetchFailureWindow) return
  tabState.prefetchFailureWindow.consecutiveAuth = 0
  tabState.prefetchFailureWindow.consecutiveMaybeAuth = 0
}

function noteTabPrefetchSuccess(tabId) {
  if (!Number.isFinite(tabId)) return
  resetPrefetchFailureStreak(state.playlistByTab.get(tabId))
}

function noteTabPrefetchFailure(tabId, errorText, options = {}) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState || isRefreshActive(tabState)) return

  const now = Date.now()
  const windowMs = constants.PREFETCH_AUTH_FAILURE_WINDOW_MS
  if (
    !tabState.prefetchFailureWindow ||
    now - tabState.prefetchFailureWindow.startedAt > windowMs
  ) {
    tabState.prefetchFailureWindow = {
      count: 0,
      authCount: 0,
      maybeAuthCount: 0,
      consecutiveAuth: 0,
      consecutiveMaybeAuth: 0,
      startedAt: now
    }
  }
  const windowState = tabState.prefetchFailureWindow
  windowState.count += 1
  const kind = classifyPrefetchError(errorText, options.authFailure, tabState, options)

  if (kind === "auth") {
    windowState.authCount += 1
    windowState.consecutiveAuth = Number(windowState.consecutiveAuth || 0) + 1
    windowState.consecutiveMaybeAuth = 0
  } else if (kind === "maybeAuth") {
    windowState.maybeAuthCount += 1
    windowState.consecutiveMaybeAuth = Number(windowState.consecutiveMaybeAuth || 0) + 1
    windowState.consecutiveAuth = 0
  } else if (kind === "rateLimit") {
    resetPrefetchFailureStreak(tabState)
    tabState.prefetchPausedUntil = Date.now() + constants.PREFETCH_RATE_LIMIT_PAUSE_MS
    addLog(
      "WARN",
      `CDN rate limit on tab ${tabId} — pausing prefetch for ${Math.round(constants.PREFETCH_RATE_LIMIT_PAUSE_MS / 1000)}s`
    )
    return
  } else {
    resetPrefetchFailureStreak(tabState)
  }

  const authThreshold = Math.max(2, Number(constants.PREFETCH_AUTH_FAILURE_THRESHOLD) || 3)
  const maybeThreshold =
    Number(constants.PREFETCH_CONSECUTIVE_MAYBE_AUTH_THRESHOLD) ||
    Number(constants.PREFETCH_NETWORK_MAYBE_AUTH_THRESHOLD) ||
    6
  const maybeWithAuth =
    Number(constants.PREFETCH_CONSECUTIVE_MAYBE_WITH_AUTH) ||
    Number(constants.PREFETCH_NETWORK_MAYBE_AUTH_WITH_AUTH) ||
    4
  const shouldRefresh =
    windowState.consecutiveAuth >= authThreshold ||
    (windowState.consecutiveAuth >= 1 &&
      windowState.consecutiveMaybeAuth >= maybeWithAuth) ||
    (tabState.mediaPlaylistUrl && windowState.consecutiveMaybeAuth >= maybeThreshold)

  if (shouldRefresh) {
    tabState.prefetchFailureWindow = null
    void requestManifestRefreshForTab(tabId, "prefetch-auth-failures")
  }
}

function rememberMediaPlaylistUrl(tabState, playlistUrl) {
  if (!tabState || typeof playlistUrl !== "string" || !playlistUrl) return
  const normalized = stripHash(playlistUrl)
  if (normalized) tabState.mediaPlaylistUrl = normalized
}

async function delegatePrefetchToPage(tabId, urls) {
  if (!urls.length) return true
  try {
    await chrome.tabs.sendMessage(tabId, { type: "AegisStream:PrefetchSegments", urls })
    addLog("INFO", `Delegated prefetch of ${urls.length} segments to page context (tab ${tabId})`)
    return true
  } catch (e) {
    addLog("WARN", `Could not delegate prefetch to tab ${tabId}: ${e.message}`)
    return false
  }
}

function upsertPlaylistState(tabId, normalizedSegments, meta = {}) {
  if (!Array.isArray(normalizedSegments) || normalizedSegments.length === 0) return null
  const previous = state.playlistByTab.get(tabId)
  const { signatures: manifestSignatures, signatureToIndex } =
    buildManifestSequenceIndex(normalizedSegments)
  const mediaPlaylistPath =
    meta.mediaPlaylistPath ||
    (meta.mediaPlaylistUrl ? getManifestUrlSignature(meta.mediaPlaylistUrl) : null) ||
    (previous?.mediaPlaylistUrl ? getManifestUrlSignature(previous.mediaPlaylistUrl) : null)
  const pageUrlForFingerprint =
    meta.pageUrl || getTabPageUrlFingerprint(tabId) || null
  const playlistFingerprint = buildPlaylistFingerprint({
    segments: normalizedSegments,
    mediaPlaylistPath,
    mediaSequence: meta.mediaSequence,
    totalDuration: meta.totalDuration,
    pageUrl: pageUrlForFingerprint
  })
  const fingerprintAssessment = scorePlaylistFingerprintChange(
    previous?.playlistFingerprint,
    playlistFingerprint,
    { isLive: meta.isLive === true || previous?.isLive === true }
  )
  const contentChangedByFingerprint = fingerprintAssessment.contentChanged
  const fingerprintReason = fingerprintAssessment.fingerprintReason
  const fingerprintScore = fingerprintAssessment.score

  const structureChanged =
    !previous?.segments ||
    previous.segments.length !== normalizedSegments.length ||
    normalizedSegments.some(
      (url, i) => getManifestUrlSignature(url) !== getManifestUrlSignature(previous.segments[i])
    )
  const urlsChanged =
    !previous?.segments ||
    previous.segments.length !== normalizedSegments.length ||
    normalizedSegments.some((url, i) => url !== previous.segments[i])
  const tokensRefreshed = urlsChanged && !structureChanged && !contentChangedByFingerprint
  const playlistChanged = structureChanged || contentChangedByFingerprint
  const episodeChangedByFingerprint =
    urlsChanged && !structureChanged && contentChangedByFingerprint
  const segmentCountChanged =
    !previous?.segments || previous.segments.length !== normalizedSegments.length
  const structuralHash = buildStructuralPlaylistHash({
    segmentDurations: meta.segmentDurations ?? previous?.segmentDurations,
    segments: normalizedSegments,
    discontinuityMarkers:
      meta.discontinuityMarkers ?? previous?.discontinuityMarkers ?? null,
    isLive: meta.isLive === true || previous?.isLive === true,
    segmentCount: normalizedSegments.length
  })
  const playbackTransition = determinePlaybackTransition(previous, {
    structuralHash,
    activeRungLabel: meta.activeRungLabel || previous?.activeRungLabel || null,
    mediaPlaylistPath,
    episodeChanged: episodeChangedByFingerprint,
    urlsChanged
  })
  const playbackState = playbackTransition.state
  const qualityVariantSwitch = playbackTransition.qualitySwitch === true

  if (urlsChanged && Array.isArray(previous?.segments) && previous.segments.length > 0) {
    if (playbackTransition.clearPrefetch) {
      clearPrefetchTrackingForUrls(previous.segments)
      if (qualityVariantSwitch || episodeChangedByFingerprint) {
        state.tabAnchorJumps.delete(tabId)
      }
    }
  }

  if (playbackState === PlaybackStates.TOKEN_REFRESHING && urlsChanged) {
    addLog(
      "DEBUG",
      `HLS playlist token refresh on tab ${tabId} (structural hash stable, anchor retained)`
    )
    if (
      playbackTransition.retainAnchor &&
      !playbackTransition.clearPrefetch &&
      typeof ns.recordTokenRefreshRetention === "function"
    ) {
      ns.recordTokenRefreshRetention()
    }
  }

  if (episodeChangedByFingerprint) {
    addLog(
      "INFO",
      `New playback detected via playlist fingerprint (${fingerprintReason || "unknown"}, score=${fingerprintScore}/${fingerprintAssessment.threshold}, tab ${tabId}) — not treating as signed-URL refresh`
    )
    bumpActivity("playlistFingerprintNewPlayback", 1)
  }

  let hasAnchor = false
  let anchorIndex = null
  let anchorRetainedByRefresh = false
  let lastScheduledFromIndex = -1

  if (
    !episodeChangedByFingerprint &&
    qualityVariantSwitch &&
    previous?.playlistMatrix?.rows?.length &&
    typeof previous.anchorIndex === "number" &&
    typeof ns.resolveMatrixAnchorIndex === "function"
  ) {
    const matrixIdx = ns.resolveMatrixAnchorIndex(
      previous.playlistMatrix,
      previous.anchorIndex,
      normalizedSegments.length
    )
    if (typeof matrixIdx === "number" && matrixIdx >= 0) {
      hasAnchor = true
      anchorIndex = matrixIdx
    }
  }

  if (
    !episodeChangedByFingerprint &&
    !hasAnchor &&
    previous?.hasAnchor &&
    typeof previous.anchorIndex === "number" &&
    Array.isArray(previous.segments) &&
    previous.segments.length > 0
  ) {
    const previousAnchorUrl = previous.segments[previous.anchorIndex]
    if (previousAnchorUrl) {
      const anchorSignature = getManifestUrlSignature(previousAnchorUrl)
      if (anchorSignature) {
        const idx = signatureToIndex.get(anchorSignature)
        if (typeof idx === "number" && idx >= 0) {
          hasAnchor = true
          anchorIndex = idx
        }
      }
    }
  }

  if (
    !episodeChangedByFingerprint &&
    !hasAnchor &&
    previous?.hasAnchor &&
    typeof previous.anchorIndex === "number" &&
    previous.isLive === true &&
    typeof previous.anchorMediaSequence === "number" &&
    typeof meta.mediaSequence === "number"
  ) {
    const remapped = previous.anchorMediaSequence - meta.mediaSequence
    if (remapped >= 0 && remapped < normalizedSegments.length) {
      hasAnchor = true
      anchorIndex = remapped
      anchorRetainedByRefresh = true
    }
  }

  if (
    !episodeChangedByFingerprint &&
    !hasAnchor &&
    previous?.hasAnchor &&
    typeof previous.anchorIndex === "number" &&
    previous.isLive !== true &&
    urlsChanged &&
    playbackTransition.retainAnchor
  ) {
    hasAnchor = true
    anchorIndex = Math.min(
      Math.max(0, previous.anchorIndex),
      normalizedSegments.length - 1
    )
    anchorRetainedByRefresh = true
  }

  if (!episodeChangedByFingerprint && !hasAnchor && urlsChanged) {
    if (
      typeof previous?.lastAnchorMediaSequenceBeforeRefresh === "number" &&
      typeof meta.mediaSequence === "number"
    ) {
      const remapped = previous.lastAnchorMediaSequenceBeforeRefresh - meta.mediaSequence
      if (remapped >= 0 && remapped < normalizedSegments.length) {
        hasAnchor = true
        anchorIndex = remapped
        anchorRetainedByRefresh = true
      }
    } else if (
      !episodeChangedByFingerprint &&
      typeof previous?.lastAnchorBeforeRefresh === "number" &&
      !structureChanged
    ) {
      hasAnchor = true
      anchorIndex = Math.min(
        Math.max(0, previous.lastAnchorBeforeRefresh),
        normalizedSegments.length - 1
      )
      anchorRetainedByRefresh = true
    }
  }

  if (hasAnchor) {
    if (!playlistChanged && typeof previous?.lastScheduledFromIndex === "number") {
      lastScheduledFromIndex = previous.lastScheduledFromIndex
    } else {
      lastScheduledFromIndex = -1
    }
  }

  if (anchorRetainedByRefresh && typeof anchorIndex === "number") {
    const via = previous?.isLive === true ? "media-sequence" : "segment-index"
    addLog(
      "INFO",
      `Retained playback anchor at index ${anchorIndex} after signed-URL refresh (${via}, tab ${tabId})`
    )
  }

  if (qualityVariantSwitch) {
    const matrixNote = previous?.playlistMatrix?.rows?.length ? " (matrix O(1) anchor)" : ""
    const queueNote = playbackTransition.clearPrefetch
      ? "cleared stale prefetch tracking"
      : "retained prefetch queue/inflight"
    addLog(
      "INFO",
      `HLS quality variant switch on tab ${tabId}${matrixNote} — ${queueNote}, resuming from anchor ${anchorIndex ?? "?"}`
    )
  }

  const tabState = {
    segments: normalizedSegments,
    manifestSignatures,
    signatureToIndex,
    updatedAt: Date.now(),
    hasAnchor,
    anchorIndex,
    anchorMediaSequence:
      hasAnchor && typeof meta.mediaSequence === "number" && typeof anchorIndex === "number"
        ? meta.mediaSequence + anchorIndex
        : previous?.anchorMediaSequence ?? null,
    isLive: meta.isLive === true,
    mediaSequence: Number.isFinite(meta.mediaSequence) ? meta.mediaSequence : null,
    lastScheduledFromIndex,
    lastScheduledAt: previous?.lastScheduledAt || 0,
    lastSkipLogAt: previous?.lastSkipLogAt || 0,
    highChurnMode: qualityVariantSwitch ? false : previous?.highChurnMode === true,
    prefetchCooldownUntil: qualityVariantSwitch
      ? 0
      : Number(previous?.prefetchCooldownUntil || 0),
    playlistRefreshedAt: urlsChanged
      ? Date.now()
      : Number(previous?.playlistRefreshedAt || 0),
    anchorRotationGraceUntil: urlsChanged
      ? Date.now() + constants.PLAYLIST_ROTATION_GRACE_MS
      : Number(previous?.anchorRotationGraceUntil || 0),
    tokensRefreshedAt: tokensRefreshed
      ? Date.now()
      : Number(previous?.tokensRefreshedAt || 0),
    mediaPlaylistUrl: previous?.mediaPlaylistUrl || null,
    manifestRefreshPending: previous?.manifestRefreshPending === true,
    manifestRefreshTimer: previous?.manifestRefreshTimer || null,
    lastManifestRefreshAt: Number(previous?.lastManifestRefreshAt || 0),
    prefetchPausedUntil: Number(previous?.prefetchPausedUntil || 0),
    anchorRetainedByRefresh:
      anchorRetainedByRefresh || previous?.anchorRetainedByRefresh === true,
    prefetchFailureWindow: previous?.prefetchFailureWindow || null,
    playlistFingerprint,
    structuralHash,
    segmentDurations: Array.isArray(meta.segmentDurations)
      ? meta.segmentDurations
      : previous?.segmentDurations || null,
    discontinuityMarkers: Array.isArray(meta.discontinuityMarkers)
      ? meta.discontinuityMarkers
      : previous?.discontinuityMarkers || null,
    teleportModeUntil: Number(previous?.teleportModeUntil || 0),
    teleportTargetIndex:
      typeof previous?.teleportTargetIndex === "number"
        ? previous.teleportTargetIndex
        : null,
    seekChurnAggressiveUntil: Number(previous?.seekChurnAggressiveUntil || 0),
    predictedAnchorIndex:
      typeof previous?.predictedAnchorIndex === "number"
        ? previous.predictedAnchorIndex
        : null,
    predictedAnchorAt: Number(previous?.predictedAnchorAt || 0),
    playbackState,
    mediaPlaylistPath: mediaPlaylistPath || previous?.mediaPlaylistPath || null,
    fingerprintReason: fingerprintReason || null,
    fingerprintScore,
    fingerprintThreshold: fingerprintAssessment.threshold,
    playlistClassification:
      playbackState === PlaybackStates.NEW_PLAYBACK
        ? "new-playback"
        : playbackState === PlaybackStates.QUALITY_SWITCHING
          ? "quality-switch"
          : playbackState === PlaybackStates.TOKEN_REFRESHING
            ? "token-refresh"
            : playbackState === PlaybackStates.STABLE_PLAYBACK && urlsChanged
              ? "stable-refresh"
              : tokensRefreshed
                ? "token-refresh"
                : urlsChanged
                  ? "urls-changed"
                  : "unchanged",
    recentAnchorChanges:
      qualityVariantSwitch || segmentCountChanged || episodeChangedByFingerprint
        ? []
        : previous?.recentAnchorChanges || [],
    rapidSeekUntil:
      qualityVariantSwitch || segmentCountChanged || episodeChangedByFingerprint
        ? 0
        : Number(previous?.rapidSeekUntil || 0),
    lastQualityVariantSwitchAt: qualityVariantSwitch
      ? Date.now()
      : Number(previous?.lastQualityVariantSwitchAt || 0),
    prefetchInflightRetryTimer: previous?.prefetchInflightRetryTimer || null,
    prefetchInflightRetryPending: previous?.prefetchInflightRetryPending || null,
    lastKnownSyncAt: previous?.lastKnownSyncAt || 0,
    lastKnownSyncSignature: previous?.lastKnownSyncSignature || "",
    lastUpsertUrlsChanged: urlsChanged,
    manifestGeneration: Number(previous?.manifestGeneration) || 0,
    pendingManifestGeneration: Number(previous?.pendingManifestGeneration) || 0,
    refreshRecoveryUntil: Number(previous?.refreshRecoveryUntil || 0),
    refreshRecoverySuccessCount: Number(previous?.refreshRecoverySuccessCount || 0),
    refreshState: previous?.refreshState || REFRESH_STATE_HEALTHY,
    refreshRetryAttempt: Number(previous?.refreshRetryAttempt || 0),
    refreshRetryTimer: previous?.refreshRetryTimer || null,
    lastAnchorBeforeRefresh:
      typeof previous?.lastAnchorBeforeRefresh === "number"
        ? previous.lastAnchorBeforeRefresh
        : null,
    lastAnchorMediaSequenceBeforeRefresh:
      typeof previous?.lastAnchorMediaSequenceBeforeRefresh === "number"
        ? previous.lastAnchorMediaSequenceBeforeRefresh
        : null,
    playlistMatrix: meta.playlistMatrix || previous?.playlistMatrix || null,
    masterPlaylistUrl: meta.masterPlaylistUrl || previous?.masterPlaylistUrl || null,
    activeRungLabel: meta.activeRungLabel || previous?.activeRungLabel || null,
    matrixBuiltAt: Number(meta.matrixBuiltAt || previous?.matrixBuiltAt || 0),
    lastSpeculativePrefetchAt: Number(previous?.lastSpeculativePrefetchAt || 0),
    lastQualitySwitchAt: qualityVariantSwitch
      ? Date.now()
      : Number(previous?.lastQualitySwitchAt || 0),
    lastQualitySwitchFromRung: qualityVariantSwitch
      ? previous?.activeRungLabel || null
      : previous?.lastQualitySwitchFromRung || null
  }
  if (
    meta.mediaPlaylistUrl &&
    tabState.playlistMatrix &&
    typeof ns.applyMatrixToTabState === "function"
  ) {
    ns.applyMatrixToTabState(tabState, meta.mediaPlaylistUrl)
  }
  state.playlistByTab.set(tabId, tabState)
  return tabState
}

function noteAnchorJump(tabId) {
  const now = Date.now()
  const entries = state.tabAnchorJumps.get(tabId) || []
  entries.push(now)
  const cutoff = now - constants.PREFETCH_TAB_BURST_WINDOW_MS
  const compacted = entries.filter((ts) => ts >= cutoff)
  state.tabAnchorJumps.set(tabId, compacted)
  return compacted.length
}

function getAnchorJumpCount(tabId) {
  const now = Date.now()
  const entries = state.tabAnchorJumps.get(tabId) || []
  const cutoff = now - constants.PREFETCH_TAB_BURST_WINDOW_MS
  const compacted = entries.filter((ts) => ts >= cutoff)
  if (compacted.length !== entries.length) {
    state.tabAnchorJumps.set(tabId, compacted)
  }
  return compacted.length
}

function remapChunkIndexViaMediaSequence(tabState, chunkIndex) {
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

function evaluateAnchorCommit(tabState, chunkIndex, previousAnchorIndex, hadAnchor) {
  const resetDeferral =
    typeof ns.resetPassiveAnchorDeferral === "function"
      ? ns.resetPassiveAnchorDeferral
      : (state) => {
          if (!state) return
          state.anchorPendingIndex = null
          state.anchorPendingCount = 0
          state.anchorLockStartedAt = 0
        }

  if (!hadAnchor || typeof previousAnchorIndex !== "number") {
    resetDeferral(tabState)
    return { accept: true, index: chunkIndex }
  }

  if (isTabInTeleportMode(tabState) && typeof tabState.teleportTargetIndex === "number") {
    const radius = Math.max(1, Number(constants.TELEPORT_MODE_RADIUS) || 5)
    if (Math.abs(chunkIndex - tabState.teleportTargetIndex) <= radius + 2) {
      resetDeferral(tabState)
      return { accept: true, index: chunkIndex }
    }
  }

  const jump = Math.abs(chunkIndex - previousAnchorIndex)
  const isZeroReset = chunkIndex === 0 && previousAnchorIndex > 10
  const isExtremeJump = jump > Number(constants.ANCHOR_TELEPORT_JUMP_THRESHOLD || 5)
  const playlistGrace =
    Date.now() - Number(tabState.playlistRefreshedAt || 0) < constants.PLAYLIST_ROTATION_GRACE_MS

  if (!isExtremeJump && !isZeroReset) {
    resetDeferral(tabState)
    return { accept: true, index: chunkIndex }
  }

  if (playlistGrace || tabState.anchorRetainedByRefresh === true) {
    return { accept: true, index: chunkIndex }
  }

  const evaluatePassive =
    typeof ns.evaluatePassiveAnchorSignal === "function"
      ? ns.evaluatePassiveAnchorSignal
      : null
  if (evaluatePassive) {
    const resolved = evaluatePassive(tabState, chunkIndex, previousAnchorIndex)
    if (resolved !== previousAnchorIndex) {
      return {
        accept: true,
        index: resolved,
        via: "monotonic-breakthrough"
      }
    }
    return {
      accept: false,
      index: previousAnchorIndex,
      reason: isZeroReset ? "zero-reset-hysteresis" : "teleport-hysteresis"
    }
  }

  return { accept: true, index: chunkIndex }
}

function shouldRejectAnchorRegression(tabState, previousAnchorIndex, chunkIndex) {
  if (typeof previousAnchorIndex !== "number" || typeof chunkIndex !== "number") return false
  const threshold = Math.max(state.settings.prefetchWindow * 2, 8)
  if (chunkIndex >= previousAnchorIndex - threshold) return false

  const backwardJump = previousAnchorIndex - chunkIndex
  const teleportThreshold = Number(constants.ANCHOR_TELEPORT_JUMP_THRESHOLD) || 5
  if (backwardJump >= teleportThreshold) {
    return false
  }
  if (
    isTabInSeekChurnAggressive(tabState) ||
    isTabInTeleportMode(tabState) ||
    isTabInRapidSeek(tabState)
  ) {
    return false
  }

  const now = Date.now()
  const playlistGrace =
    now - Number(tabState.playlistRefreshedAt || 0) < constants.PLAYLIST_ROTATION_GRACE_MS
  const rotationGrace = now < Number(tabState.anchorRotationGraceUntil || 0)
  const retained = tabState.anchorRetainedByRefresh === true && playlistGrace

  return playlistGrace || rotationGrace || retained
}

function maybeRequestPrefetchForTab(tabId, segments, startIndex, source, options = {}) {
  if (isReactivePrefetchTab(tabId)) {
    addLog("DEBUG", `Reactive media mode: forward prefetch disabled (${source}, tab ${tabId})`)
    return
  }
  const tabState = state.playlistByTab.get(tabId)
  if (isPrefetchBlocked(tabState)) return
  if (!options.force) {
    if (isTabInRapidSeek(tabState) && !isTabInSeekChurnAggressive(tabState)) return
    if (isTabInAnchorCooldown(tabState) && !isTabInTeleportMode(tabState)) return
  }
  requestPrefetchForTab(tabId, segments, startIndex, source, options)
}

function resolveEffectivePrefetchWindow(tabId) {
  if (isReactivePrefetchTab(tabId)) return 0
  const baseWindow = Math.max(1, Number(state.settings.prefetchWindow) || 1)
  const jumps = getAnchorJumpCount(tabId)
  let windowSize = baseWindow
  const tabState = state.playlistByTab.get(tabId)
  const recentVariantSwitch =
    Date.now() - Number(tabState?.lastQualityVariantSwitchAt || 0) < 5000
  if (tabState && isTabInSeekChurnAggressive(tabState)) {
    windowSize = Math.max(
      windowSize,
      Number(constants.SEEK_CHURN_PREFETCH_WINDOW_MIN) || 10
    )
  } else if (jumps >= constants.PREFETCH_TAB_BURST_THRESHOLD && !recentVariantSwitch) {
    windowSize = Math.max(baseWindow, constants.PREFETCH_BURST_WINDOW_CAP)
  }
  if (isInRefreshRecovery(tabState)) {
    windowSize = Math.min(windowSize, constants.REFRESH_RECOVERY_MAX_CHUNKS)
  }
  return resolveBufferAdjustedPrefetchWindow(tabId, windowSize)
}

function shouldSkipDuplicateSchedule(tabState, startIndex, now, force) {
  if (force) return false
  const lastIndex = Number(tabState.lastScheduledFromIndex)
  if (!Number.isFinite(lastIndex) || lastIndex < 0) return false
  const lastAt = Number(tabState.lastScheduledAt || 0)
  if (!Number.isFinite(lastAt) || now - lastAt > constants.PREFETCH_DUPLICATE_WINDOW_MS) return false
  if (startIndex === lastIndex) return true
  if (startIndex < lastIndex && lastIndex - startIndex <= 2) return true
  return false
}

function computeFailureBackoffMs(attempts) {
  const exponent = Math.min(
    constants.PREFETCH_MAX_BACKOFF_EXPONENT,
    Math.max(0, Number(attempts || 1) - 1)
  )
  return Math.min(constants.PREFETCH_MAX_RETRY_MS, constants.PREFETCH_BASE_RETRY_MS * 2 ** exponent)
}

function updatePrefetchOutcome(url, success, error = "unknown", options = {}) {
  const normalizedUrl = normalizePrefetchUrl(url)
  if (!normalizedUrl) {
    return { attempts: 0, retryAfter: 0 }
  }

  const inflight = state.inflightPrefetches.get(normalizedUrl)
  const tabId = options.tabId ?? inflight?.tabId
  state.inflightPrefetches.delete(normalizedUrl)

  if (success) {
    state.failedPrefetches.delete(normalizedUrl)
    if (Number.isFinite(tabId)) {
      const tabState = state.playlistByTab.get(tabId)
      noteTabPrefetchSuccess(tabId)
      noteRefreshRecoverySuccess(tabId, tabState)
    }
    return { attempts: 0, retryAfter: 0 }
  }

  const previous = state.failedPrefetches.get(normalizedUrl)
  const previousAttempts =
    typeof previous === "number" ? 1 : Math.max(0, Number(previous?.attempts || 0))
  const attempts = previousAttempts + 1
  const transient = options.transient === true
  const backoffMs = transient
    ? Math.max(1500, Math.round(computeFailureBackoffMs(attempts) * 0.5))
    : computeFailureBackoffMs(attempts)
  const retryAfter = Date.now() + backoffMs
  state.failedPrefetches.set(normalizedUrl, {
    attempts,
    retryAfter,
    lastFailedAt: Date.now(),
    lastError: String(error || "unknown"),
    transient
  })
  return { attempts, retryAfter, transient }
}

function computeCapRetryDelayMs(attempt) {
  const base = Math.max(50, Number(constants.PREFETCH_CAP_RETRY_BASE_MS) || 200)
  const max = Math.max(base, Number(constants.PREFETCH_CAP_RETRY_MAX_MS) || 3200)
  const exponent = Math.max(0, Number(attempt) - 1)
  return Math.min(max, Math.round(base * 2 ** exponent))
}

function clearPrefetchCapRetry(tabState) {
  if (!tabState) return
  if (tabState.prefetchCapRetryTimer) {
    clearTimeout(tabState.prefetchCapRetryTimer)
    tabState.prefetchCapRetryTimer = null
  }
  tabState.prefetchCapRetryPending = null
  tabState.prefetchCapRetryAttempts = 0
  tabState.prefetchCapRetryDelayMs = 0
}

function clearPrefetchInflightRetry(tabState) {
  if (!tabState) return
  if (tabState.prefetchInflightRetryTimer) {
    clearTimeout(tabState.prefetchInflightRetryTimer)
    tabState.prefetchInflightRetryTimer = null
  }
  tabState.prefetchInflightRetryPending = null
}

function schedulePrefetchInflightRetry(tabId, tabState, segments, startIndex, source = "schedule") {
  if (!tabState) return
  const pendingSnapshot = {
    segments,
    startIndex,
    source,
    queuedAt: Date.now()
  }
  tabState.prefetchInflightRetryPending = pendingSnapshot
  if (tabState.prefetchInflightRetryTimer) {
    clearTimeout(tabState.prefetchInflightRetryTimer)
  }
  tabState.prefetchInflightRetryTimer = setTimeout(() => {
    tabState.prefetchInflightRetryTimer = null
    const pending = tabState.prefetchInflightRetryPending
    if (!pending) return
    tabState.prefetchInflightRetryPending = null
    if (isPrefetchWorkStale(tabState, pending)) {
      dropStalePrefetchWork(tabId, tabState, pending, "inflight-retry-stale")
      return
    }
    void schedulePrefetch(tabId, pending.segments, pending.startIndex, {
      source: pending.source,
      force: true,
      inflightRetry: true
    })
  }, constants.PREFETCH_INFLIGHT_RETRY_MS)
}

function isPrefetchWorkStale(tabState, pending) {
  if (!pending) return true
  const queuedAt = Number(pending.queuedAt || 0)
  if (queuedAt > 0 && Date.now() - queuedAt > constants.PREFETCH_QUEUE_MAX_AGE_MS) {
    return true
  }
  if (
    tabState?.hasAnchor &&
    typeof tabState.anchorIndex === "number" &&
    typeof pending.startIndex === "number"
  ) {
    const drift = tabState.anchorIndex - pending.startIndex
    const maxDrift = Math.max(state.settings.prefetchWindow * 2, 8)
    if (drift > maxDrift) return true
  }
  return false
}

function dropStalePrefetchWork(tabId, tabState, pending, reason) {
  clearPrefetchCapRetry(tabState)
  clearPrefetchInflightRetry(tabState)
  const ageSec =
    pending?.queuedAt > 0 ? Math.round((Date.now() - pending.queuedAt) / 1000) : null
  addLog(
    "INFO",
    `Dropped stale prefetch work on tab ${tabId} (${reason}${ageSec !== null ? `, age=${ageSec}s` : ""})`
  )
}

function schedulePrefetchCapRetry(tabId, tabState, segments, startIndex, source) {
  if (!tabState) return

  const existing = tabState.prefetchCapRetryPending
  const queuedAt = existing?.queuedAt || Date.now()
  const pendingSnapshot = {
    segments,
    startIndex,
    source,
    queuedAt
  }

  if (isPrefetchWorkStale(tabState, pendingSnapshot)) {
    dropStalePrefetchWork(tabId, tabState, pendingSnapshot, "queue-age")
    return
  }

  const attempts = Number(tabState.prefetchCapRetryAttempts || 0) + 1
  if (attempts > constants.PREFETCH_CAP_RETRY_MAX_ATTEMPTS) {
    clearPrefetchCapRetry(tabState)
    addLog(
      "WARN",
      `Prefetch cap retry exhausted on tab ${tabId} after ${constants.PREFETCH_CAP_RETRY_MAX_ATTEMPTS} attempts`
    )
    return
  }
  const delayMs = computeCapRetryDelayMs(attempts)
  tabState.prefetchCapRetryAttempts = attempts
  tabState.prefetchCapRetryDelayMs = delayMs
  tabState.prefetchCapRetryPending = pendingSnapshot
  if (tabState.prefetchCapRetryTimer) {
    clearTimeout(tabState.prefetchCapRetryTimer)
  }
  tabState.prefetchCapRetryTimer = setTimeout(() => {
    tabState.prefetchCapRetryTimer = null
    const pending = tabState.prefetchCapRetryPending
    if (!pending) return
    if (isPrefetchWorkStale(tabState, pending)) {
      dropStalePrefetchWork(tabId, tabState, pending, "queue-age")
      return
    }
    tabState.prefetchCapRetryPending = null
    void schedulePrefetch(tabId, pending.segments, pending.startIndex, {
      source: pending.source,
      force: true,
      capRetry: true
    })
  }, delayMs)
}

async function schedulePrefetch(tabId, segments, startIndex = 0, options = {}) {
  if (!state.settings.enabled || !state.settings.prefetchEnabled) return
  if (!isTabEligibleForPrefetch(tabId)) return
  const normalized = normalizeSegments(segments)
  if (!normalized.length) return
  const tabState = upsertPlaylistState(tabId, normalized)
  if (!tabState) return
  if (isPrefetchBlocked(tabState)) return
  if (isTabInAnchorCooldown(tabState)) return

  const force = Boolean(options.force)
  const now = Date.now()
  const clampedStartIndex = Math.max(0, Math.min(startIndex, normalized.length))

  if (shouldSkipDuplicateSchedule(tabState, clampedStartIndex, now, force)) {
    return
  }

  const effectiveWindow = resolveEffectivePrefetchWindow(tabId)
  if (effectiveWindow === 0) {
    tabState.lastScheduledFromIndex = clampedStartIndex
    tabState.lastScheduledAt = now
    tabState.updatedAt = now
    return
  }

  if (tabState.highChurnMode === true && !isTabInSeekChurnAggressive(tabState)) {
    tabState.highChurnMode = false
    addLog(
      "INFO",
      `Seek churn normalized on tab ${tabId}; restoring prefetch window to ${state.settings.prefetchWindow}`
    )
  } else if (isTabInSeekChurnAggressive(tabState) && effectiveWindow >= state.settings.prefetchWindow) {
    addLog(
      "INFO",
      `Seek churn aggressive on tab ${tabId}; prefetch window ${effectiveWindow} (guard ring expanded)`
    )
  }

  const targets = normalized.slice(
    clampedStartIndex,
    clampedStartIndex + effectiveWindow
  )
  if (!targets.length) return

  const uncached = []
  let blockedInflight = 0
  let blockedCooldown = 0

  for (const url of targets) {
    const normalizedUrl = normalizePrefetchUrl(url)
    if (!normalizedUrl) continue

    const inflight = state.inflightPrefetches.get(normalizedUrl)
    if (inflight) {
      if (now - Number(inflight.startedAt || 0) < constants.PREFETCH_INFLIGHT_TTL_MS) {
        blockedInflight += 1
        continue
      }
      state.inflightPrefetches.delete(normalizedUrl)
    }

    const failed = state.failedPrefetches.get(normalizedUrl)
    if (failed) {
      const retryAfter = typeof failed === "number" ? failed : Number(failed.retryAfter || 0)
      if (retryAfter > now) {
        blockedCooldown += 1
        continue
      }
    }

    const existing = await resolveCachedChunk(normalizedUrl)
    if (!existing) uncached.push(url)
  }

  const globalCap = resolveBufferAdjustedGlobalCap(tabId)
  const globalInflight = countGlobalInflightPrefetches()
  const tier = typeof getTabBufferTier === "function" ? getTabBufferTier(tabId) : null
  const panicActive = typeof ns.isNetworkPanicActive === "function" && ns.isNetworkPanicActive()
  const churnOrTeleport =
    isTabInSeekChurnAggressive(tabState) || isTabInTeleportMode(tabState)
  const batchInflightCap =
    churnOrTeleport
      ? Math.min(10, constants.PREFETCH_BATCH_INFLIGHT_CAP + 2)
      : panicActive || tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE
        ? constants.PREFETCH_BATCH_INFLIGHT_CAP + 2
        : constants.PREFETCH_BATCH_INFLIGHT_CAP

  if (globalInflight >= globalCap) {
    if (!options.capRetry) {
      schedulePrefetchCapRetry(tabId, tabState, normalized, clampedStartIndex, options.source || "schedule")
    }
    const shouldLogSkip = now - tabState.lastSkipLogAt > constants.PREFETCH_LOG_THROTTLE_MS
    if (shouldLogSkip) {
      const retryDelay = tabState.prefetchCapRetryDelayMs || computeCapRetryDelayMs(1)
      addLog(
        "INFO",
        `Prefetch queued (cap ${globalInflight}/${globalCap}) — retry #${tabState.prefetchCapRetryAttempts || 1} on tab ${tabId} in ${retryDelay}ms`
      )
      tabState.lastSkipLogAt = now
    }
    tabState.lastScheduledFromIndex = clampedStartIndex
    tabState.lastScheduledAt = now
    tabState.updatedAt = now
    return
  }

  clearPrefetchCapRetry(tabState)

  const availableSlots = globalCap - globalInflight
  const batch = uncached.slice(0, Math.min(availableSlots, batchInflightCap))

  if (!batch.length) {
    const shouldLogSkip = now - tabState.lastSkipLogAt > constants.PREFETCH_LOG_THROTTLE_MS
    if ((blockedInflight > 0 || blockedCooldown > 0) && shouldLogSkip) {
      addLog(
        "INFO",
        `Prefetch paused on tab ${tabId}: inflight=${blockedInflight}, retryCooldown=${blockedCooldown}`
      )
      tabState.lastSkipLogAt = now
    } else if (blockedInflight === 0 && blockedCooldown === 0 && shouldLogSkip) {
      addLog("INFO", `All ${targets.length} target chunks already cached`)
      tabState.lastSkipLogAt = now
    }
    if (blockedInflight > 0 && uncached.length > 0 && !options.inflightRetry) {
      schedulePrefetchInflightRetry(
        tabId,
        tabState,
        normalized,
        clampedStartIndex,
        options.source || "schedule"
      )
    }
    tabState.lastScheduledFromIndex = clampedStartIndex
    tabState.lastScheduledAt = now
    tabState.updatedAt = now
    return
  }

  clearPrefetchInflightRetry(tabState)

  const source = options.source || "schedule"
  const inflightAt = Date.now()
  for (const url of batch) {
    const normalizedUrl = normalizePrefetchUrl(url)
    if (!normalizedUrl) continue
    state.inflightPrefetches.set(normalizedUrl, {
      tabId,
      source,
      startedAt: inflightAt
    })
  }

  addLog(
    "INFO",
    `Scheduling prefetch of ${batch.length} chunks for tab ${tabId} (from index ${clampedStartIndex})`
  )
  tabState.lastScheduledFromIndex = clampedStartIndex
  tabState.lastScheduledAt = now
  tabState.updatedAt = now

  const delegated = await delegatePrefetchToPage(tabId, batch)
  if (!delegated) {
    for (const url of batch) {
      updatePrefetchOutcome(url, false, "delegate-failed")
    }
    return
  }

  if (uncached.length > batch.length) {
    schedulePrefetchCapRetry(tabId, tabState, normalized, clampedStartIndex, options.source || "schedule")
  }

  if (typeof ns.maybeScheduleSpeculativePrefetch === "function") {
    ns.maybeScheduleSpeculativePrefetch(tabId)
  }
}

function requestPrefetchForTab(tabId, segments, startIndex = 0, source = "anchor", options = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return
  if (!isTabEligibleForPrefetch(tabId)) return

  const tabState = state.playlistByTab.get(tabId)
  if (isPrefetchBlocked(tabState)) return

  const tier = typeof getTabBufferTier === "function" ? getTabBufferTier(tabId) : null
  const panicActive = typeof ns.isNetworkPanicActive === "function" && ns.isNetworkPanicActive()
  const now = Date.now()
  const minGap =
    options.force
      ? 0
      : panicActive || tier === TIER_EMERGENCY
        ? constants.PREFETCH_EMERGENCY_MIN_GAP_MS
        : tier === TIER_AGGRESSIVE
          ? 250
          : 0
  if (
    minGap > 0 &&
    tabState?.lastPrefetchRequestAt &&
    now - tabState.lastPrefetchRequestAt < minGap
  ) {
    return
  }
  if (tabState) tabState.lastPrefetchRequestAt = now

  const existing = state.pendingPrefetchByTab.get(tabId)
  if (existing?.timerId) {
    clearTimeout(existing.timerId)
  }

  const queuedAt = existing?.queuedAt || Date.now()
  const clampedStartIndex = Math.max(0, Number(startIndex) || 0)
  const pendingSnapshot = {
    segments,
    startIndex: clampedStartIndex,
    source,
    queuedAt,
    options
  }

  if (isPrefetchWorkStale(tabState, pendingSnapshot)) {
    dropStalePrefetchWork(tabId, tabState, pendingSnapshot, "debounce-queue")
    return
  }

  const timerId = setTimeout(() => {
    const pending = state.pendingPrefetchByTab.get(tabId)
    if (!pending) return
    state.pendingPrefetchByTab.delete(tabId)
    const currentTabState = state.playlistByTab.get(tabId)
    if (isPrefetchWorkStale(currentTabState, pending)) {
      dropStalePrefetchWork(tabId, currentTabState, pending, "debounce-queue")
      return
    }
    void schedulePrefetch(
      tabId,
      pending.segments,
      pending.startIndex,
      { source: pending.source, ...(pending.options || {}) }
    )
  }, constants.PREFETCH_BATCH_DEBOUNCE_MS)

  state.pendingPrefetchByTab.set(tabId, {
    timerId,
    source,
    startIndex: clampedStartIndex,
    segments,
    queuedAt,
    options
  })
}

function syncKnownSegmentsToPage(tabId, segments, options = {}) {
  if (!segments || !segments.length) return
  const tabState = state.playlistByTab.get(tabId)
  const now = Date.now()
  const signature = `${segments.length}:${segments[0]}:${segments[segments.length - 1]}`
  const reasonText = String(options.reason || "")
  const shouldForce =
    reasonText.startsWith("reinject:") ||
    reasonText === "tab-activated" ||
    reasonText === "tab-updated"
  if (
    tabState &&
    !shouldForce &&
    tabState.lastKnownSyncSignature === signature &&
    now - Number(tabState.lastKnownSyncAt || 0) < 8000
  ) {
    return
  }
  if (tabState) {
    tabState.lastKnownSyncSignature = signature
    tabState.lastKnownSyncAt = now
  }
  const reason = options.reason ? ` (${options.reason})` : ""
  const playbackHint = tabState
    ? {
        segmentDurations: Array.isArray(tabState.segmentDurations) ? tabState.segmentDurations : null,
        segmentCount: tabState.segments?.length || segments.length,
        totalDuration: tabState.playlistFingerprint?.totalDuration ?? null
      }
    : null
  chrome.tabs
    .sendMessage(tabId, {
      type: "AegisStream:KnownSegments",
      urls: segments,
      playbackHint
    })
    .then(() => {
      addLog(
        "INFO",
        `Synced ${segments.length} known segments to page bridge (tab ${tabId})${reason}`
      )
    })
    .catch((e) => {
      addLog("WARN", `Failed to sync known segments to tab ${tabId}: ${e.message}`)
    })
}

async function parseAndPrefetchFromPlaylist(tabId, playlistUrl, depth = 0) {
  const normalizedPlaylistUrl = stripHash(playlistUrl)
  if (!normalizedPlaylistUrl) return
  if (isReactivePrefetchTab(tabId) || isTwitchMediaUrl(normalizedPlaylistUrl)) {
    addLog(
      "DEBUG",
      `Skipping background playlist fetch on Twitch reactive tab ${tabId}: ${normalizedPlaylistUrl.slice(-80)}`
    )
    return
  }

  const inflightKey = `${tabId}|${normalizedPlaylistUrl}|${depth}`
  if (playlistFetchInFlight.has(inflightKey)) return
  const completedAt = Number(playlistFetchCompletedAt.get(inflightKey) || 0)
  if (Date.now() - completedAt < 5000) return

  playlistFetchInFlight.add(inflightKey)
  try {
    addLog("DEBUG", `Fetching playlist (depth=${depth}): ${normalizedPlaylistUrl.slice(-100)}`)
    const res = await fetch(normalizedPlaylistUrl, { credentials: "include", cache: "no-store" })
    if (!res.ok) {
      addLog("WARN", `Playlist fetch failed: HTTP ${res.status} — ${normalizedPlaylistUrl.slice(-80)}`)
      return
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase()
    const text = await res.text()
    const isHls =
      /\.m3u8($|\?)/i.test(normalizedPlaylistUrl) ||
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegurl") ||
      text.trimStart().startsWith("#EXTM3U")
    const isDash =
      /\.mpd($|\?)/i.test(normalizedPlaylistUrl) ||
      contentType.includes("dash+xml") ||
      (text.trimStart().startsWith("<?xml") && /<MPD\b/i.test(text))

    if (isHls) {
      const parsed = parseHlsPlaylist(text, normalizedPlaylistUrl)
      addLog(
        "INFO",
        `HLS playlist parsed: ${parsed.kind}, ${parsed.variants.length} variants, ${parsed.segments.length} segments`
      )
      if (parsed.kind === "master") {
        bumpActivity("playlistsDetected", 1)
        if (depth >= 1) return
        if (typeof ns.ingestMasterPlaylist === "function") {
          await ns.ingestMasterPlaylist(tabId, normalizedPlaylistUrl, parsed.variants)
        }
        return
      }
      bumpActivity("playlistsDetected", 1)
      const tabState = upsertPlaylistState(tabId, normalizeSegments(parsed.segments), {
        isLive: parsed.isLive === true,
        mediaSequence: parsed.mediaSequence,
        totalDuration: parsed.totalDuration,
        mediaPlaylistUrl: normalizedPlaylistUrl,
        segmentDurations: parsed.segmentDurations,
        discontinuityMarkers: parsed.discontinuityMarkers
      })
      if (!tabState?.segments?.length) {
        addLog("WARN", `HLS media playlist had 0 segments: ${normalizedPlaylistUrl.slice(-60)}`)
        return
      }
      rememberMediaPlaylistUrl(tabState, normalizedPlaylistUrl)
      finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged)
      syncKnownSegmentsToPage(tabId, tabState.segments)
      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        addLog("INFO", `Playlist refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
        maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "playlist-refresh")
      } else {
        addLog("INFO", "Awaiting player segment request to anchor HLS prefetch (JIT mode)")
      }
      return
    }

    if (!isDash) {
      addLog(
        "WARN",
        `Unknown playlist format for ${normalizedPlaylistUrl.slice(-60)} (content-type: ${contentType})`
      )
      return
    }
    const segments = parseDashPlaylist(text, normalizedPlaylistUrl)
    bumpActivity("playlistsDetected", 1)
    addLog("INFO", `DASH manifest parsed: ${segments.length} segments`)
    const tabState = upsertPlaylistState(tabId, normalizeSegments(segments))
    if (!tabState?.segments?.length) return
    rememberMediaPlaylistUrl(tabState, normalizedPlaylistUrl)
    finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged)
    syncKnownSegmentsToPage(tabId, tabState.segments)
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      addLog("INFO", `DASH playlist refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
      maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "playlist-refresh")
    } else {
      addLog("INFO", "Awaiting player segment request to anchor DASH prefetch (JIT mode)")
    }
  } catch (e) {
    addLog("ERROR", `Playlist error: ${e.message}`)
  } finally {
    playlistFetchInFlight.delete(inflightKey)
    playlistFetchCompletedAt.set(inflightKey, Date.now())
  }
}

async function parsePlaylistContentForTab(tabId, playlistUrl, text, options = {}) {
  if (!state.settings.enabled) return
  if (!text || !tabId) return
  const pageUrl = options.pageUrl || null
  const generation = options.generation
  if (pageUrl) noteTabPageUrl(tabId, pageUrl)
  const normalizedUrl = stripHash(playlistUrl) || playlistUrl
  try {
    const isHls = /\.m3u8($|\?)/i.test(normalizedUrl) || text.trimStart().startsWith("#EXTM3U")
    const isDash =
      /\.mpd($|\?)/i.test(normalizedUrl) ||
      (text.trimStart().startsWith("<?xml") && /<MPD\b/i.test(text))

    if (isHls) {
      const parsed = parseHlsPlaylist(text, normalizedUrl)
      addLog(
        "INFO",
        `HLS parsed from page capture: ${parsed.kind}, ${parsed.variants.length} variants, ${parsed.segments.length} segments`
      )
      if (parsed.kind === "master") {
        bumpActivity("playlistsDetected", 1)
        if (typeof ns.ingestMasterPlaylist === "function") {
          await ns.ingestMasterPlaylist(tabId, normalizedUrl, parsed.variants)
        } else {
          addLog(
            "INFO",
            `Master playlist with ${parsed.variants.length} variants — waiting for page to load variant playlists`
          )
        }
        return
      }
      bumpActivity("playlistsDetected", 1)
      if (!parsed.segments.length) {
        addLog("WARN", `HLS media playlist had 0 segments: ${normalizedUrl.slice(-60)}`)
        return
      }
      const tabStateBefore = state.playlistByTab.get(tabId)
      const normalizedSegments = normalizeSegments(parsed.segments)
      const urlsChanged = segmentsUrlsChanged(tabStateBefore?.segments, normalizedSegments)
      if (!shouldAcceptPlaylistCapture(tabStateBefore, generation, urlsChanged)) {
        addLog(
          "DEBUG",
          `Discarded stale playlist capture on tab ${tabId}${generation ? ` (gen ${generation})` : ""}`
        )
        return
      }
      const tabState = upsertPlaylistState(tabId, normalizedSegments, {
        isLive: parsed.isLive === true,
        mediaSequence: parsed.mediaSequence,
        totalDuration: parsed.totalDuration,
        mediaPlaylistUrl: normalizedUrl,
        pageUrl,
        segmentDurations: parsed.segmentDurations,
        discontinuityMarkers: parsed.discontinuityMarkers
      })
      if (!tabState?.segments?.length) {
        addLog("WARN", `HLS media playlist had 0 usable segments: ${normalizedUrl.slice(-60)}`)
        return
      }
      rememberMediaPlaylistUrl(tabState, normalizedUrl)
      finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged, generation)
      syncKnownSegmentsToPage(tabId, tabState.segments)
      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        addLog("INFO", `Captured HLS refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
        const forcePrefetch =
          tabState.anchorRetainedByRefresh === true ||
          Date.now() - Number(tabState.lastQualityVariantSwitchAt || 0) < 3000
        maybeRequestPrefetchForTab(
          tabId,
          tabState.segments,
          tabState.anchorIndex + 1,
          "captured-playlist",
          { force: forcePrefetch }
        )
      } else {
        const startSeconds = extractStartSecondsFromPageUrl(pageUrl)
        if (startSeconds !== null) {
          addLog("INFO", `Page has seek hint t=${startSeconds.toFixed(1)}s; waiting for explicit segment request anchor`)
        } else {
          addLog("INFO", "Awaiting player segment request to anchor captured HLS prefetch (JIT mode)")
        }
      }
      return
    }

    if (!isDash) {
      addLog("WARN", `Captured playlist content doesn't look like HLS or DASH: ${normalizedUrl.slice(-60)}`)
      return
    }
    const segments = parseDashPlaylist(text, normalizedUrl)
    bumpActivity("playlistsDetected", 1)
    addLog("INFO", `DASH parsed from page capture: ${segments.length} segments`)
    if (!segments.length) return
    const tabStateBefore = state.playlistByTab.get(tabId)
    const normalizedSegments = normalizeSegments(segments)
    const urlsChanged = segmentsUrlsChanged(tabStateBefore?.segments, normalizedSegments)
    if (!shouldAcceptPlaylistCapture(tabStateBefore, generation, urlsChanged)) {
      addLog(
        "DEBUG",
        `Discarded stale playlist capture on tab ${tabId}${generation ? ` (gen ${generation})` : ""}`
      )
      return
    }
    const tabState = upsertPlaylistState(tabId, normalizedSegments)
    if (!tabState?.segments?.length) return
    rememberMediaPlaylistUrl(tabState, normalizedUrl)
    finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged, generation)
    syncKnownSegmentsToPage(tabId, tabState.segments)
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      addLog("INFO", `Captured DASH refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
      const forcePrefetch =
        tabState.anchorRetainedByRefresh === true ||
        Date.now() - Number(tabState.lastQualityVariantSwitchAt || 0) < 3000
      maybeRequestPrefetchForTab(
        tabId,
        tabState.segments,
        tabState.anchorIndex + 1,
        "captured-playlist",
        { force: forcePrefetch }
      )
    } else {
      addLog("INFO", "Awaiting player segment request to anchor captured DASH prefetch (JIT mode)")
    }
  } catch (e) {
    addLog("ERROR", `Error parsing captured playlist: ${e.message}`)
  }
}

async function handleChunkObserved(tabId, chunkUrl, options = {}) {
  const normalizedChunkUrl = stripHash(chunkUrl)
  if (!normalizedChunkUrl) return
  if (options.countMetric !== false && shouldCountChunkObserved(tabId, normalizedChunkUrl)) {
    bumpActivity("chunksObserved", 1)
  }
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length || !tabState.signatureToIndex) return
  tabState.updatedAt = Date.now()
  let chunkIndex = resolveSegmentIndexInManifest(normalizedChunkUrl, tabState)
  if (typeof chunkIndex !== "number") return
  chunkIndex = remapChunkIndexViaMediaSequence(tabState, chunkIndex)

  const hadAnchor = tabState.hasAnchor === true
  const previousAnchorIndex = tabState.anchorIndex
  const wasRetainedAnchor = tabState.anchorRetainedByRefresh === true

  if (
    hadAnchor &&
    typeof previousAnchorIndex === "number" &&
    shouldRejectAnchorRegression(tabState, previousAnchorIndex, chunkIndex)
  ) {
    addLog(
      "DEBUG",
      `Ignored spurious anchor regression ${previousAnchorIndex} -> ${chunkIndex} during playlist rotation (tab ${tabId})`
    )
    return
  }

  const anchorDecision = evaluateAnchorCommit(tabState, chunkIndex, previousAnchorIndex, hadAnchor)
  if (!anchorDecision.accept) {
    if (typeof ns.recordAnchorDeferred === "function") {
      ns.recordAnchorDeferred()
    }
    addLog(
      "DEBUG",
      `Deferred anchor ${previousAnchorIndex} -> ${chunkIndex} (${anchorDecision.reason || "hysteresis"}, tab ${tabId})`
    )
    return
  }
  chunkIndex = anchorDecision.index

  const anchorMoved =
    !hadAnchor ||
    (typeof previousAnchorIndex === "number" && chunkIndex !== previousAnchorIndex)
  if (anchorMoved) {
    if (anchorDecision.via === "monotonic-breakthrough") {
      if (typeof ns.recordMonotonicBreakthrough === "function") {
        ns.recordMonotonicBreakthrough()
      }
    } else if (typeof ns.recordAnchorCommit === "function") {
      ns.recordAnchorCommit(ns.AnchorAuthority?.NETWORK ?? 1)
    }
  }

  tabState.hasAnchor = true
  tabState.anchorIndex = chunkIndex
  tabState.anchorRetainedByRefresh = false
  if (typeof tabState.mediaSequence === "number") {
    tabState.anchorMediaSequence = tabState.mediaSequence + chunkIndex
  }
  if (typeof ns.resolveSeekPredictionActual === "function") {
    ns.resolveSeekPredictionActual(tabId, chunkIndex, { source: "player-segment" })
  }
  noteRefreshRecoverySuccess(tabId, tabState)
  if (hadAnchor && typeof previousAnchorIndex === "number" && chunkIndex !== previousAnchorIndex) {
    noteAnchorChange(tabState, previousAnchorIndex, chunkIndex)
  }
  if (!hadAnchor) {
    tabState.lastScheduledFromIndex = -1
    addLog(
      "INFO",
      `Player anchor acquired at manifest index ${chunkIndex}/${tabState.segments.length - 1} (tab ${tabId})`
    )
  } else if (
    typeof previousAnchorIndex === "number" &&
    Math.abs(chunkIndex - previousAnchorIndex) > Math.max(state.settings.prefetchWindow * 2, 8)
  ) {
    const playlistJustRefreshed =
      Date.now() - Number(tabState.playlistRefreshedAt || 0) < 8_000
    const retainedDrift =
      wasRetainedAnchor ||
      (playlistJustRefreshed && Math.abs(chunkIndex - previousAnchorIndex) <= 4)
    if (chunkIndex < previousAnchorIndex) {
      tabState.lastScheduledFromIndex = -1
    }
    if (retainedDrift) {
      addLog(
        "INFO",
        `Playlist refresh anchor drift ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId}); skipping seek-churn handling`
      )
    } else if (Math.abs(chunkIndex - previousAnchorIndex) > 1) {
      const teleportThreshold = Number(constants.TELEPORT_MODE_JUMP_THRESHOLD) || 20
      if (Math.abs(chunkIndex - previousAnchorIndex) >= teleportThreshold) {
        enterTeleportMode(tabId, tabState, chunkIndex, "anchor-jump")
        if (typeof ns.recordTeleportHard === "function") {
          ns.recordTeleportHard()
        }
      } else {
        noteAnchorJump(tabId)
        applyAnchorJumpCooldown(tabState, previousAnchorIndex, chunkIndex)
        markSeekChurnAggressive(tabState)
        addLog(
          "INFO",
          `Player anchor jumped from ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId})`
        )
      }
    }
  }
  if (
    isTabEligibleForPrefetch(tabId) &&
    (!isTabInAnchorCooldown(tabState) || isTabInTeleportMode(tabState)) &&
    (!isTabInRapidSeek(tabState) || isTabInSeekChurnAggressive(tabState))
  ) {
    maybeRequestPrefetchForTab(tabId, tabState.segments, chunkIndex + 1, "chunk-observed")
  }
  if (typeof ns.maybeScheduleSpeculativePrefetch === "function") {
    ns.maybeScheduleSpeculativePrefetch(tabId)
  }
}

function observeChunkFromWebRequest(tabId, chunkUrl) {
  if (!isTabEligibleForPrefetch(tabId)) return
  void handleChunkObserved(tabId, chunkUrl)
}

ns.pruneRuntimeState = pruneRuntimeState
ns.parseAndPrefetchFromPlaylist = parseAndPrefetchFromPlaylist
ns.parsePlaylistContentForTab = parsePlaylistContentForTab
ns.handleChunkObserved = handleChunkObserved
ns.handleSeekPrediction = handleSeekPrediction
ns.commitAnchorFromAuthority = commitAnchorFromAuthority
ns.handleForceTeleportAnchor = handleForceTeleportAnchor
ns.isTabInSeekChurnAggressive = isTabInSeekChurnAggressive
ns.isTabInTeleportMode = isTabInTeleportMode
ns.observeChunkFromWebRequest = observeChunkFromWebRequest
ns.isTabInRapidSeek = isTabInRapidSeek
ns.schedulePrefetch = schedulePrefetch
ns.requestPrefetchForTab = requestPrefetchForTab
ns.maybeRequestPrefetchForTab = maybeRequestPrefetchForTab
ns.syncKnownSegmentsToPage = syncKnownSegmentsToPage
ns.updatePrefetchOutcome = updatePrefetchOutcome
ns.noteTabPrefetchFailure = noteTabPrefetchFailure
ns.requestManifestRefreshForTab = requestManifestRefreshForTab
ns.noteManifestRefreshFailed = noteManifestRefreshFailed
ns.transitionTabRefreshState = transitionRefreshState
ns.getTabRefreshState = (tabId) => state.playlistByTab.get(tabId)?.refreshState || REFRESH_STATE_HEALTHY
ns.formatTabStateLabel = (tabState) => formatTabStateLabel(tabState)
ns.delegatePrefetchToPage = delegatePrefetchToPage
ns.REFRESH_STATE_HEALTHY = REFRESH_STATE_HEALTHY
ns.REFRESH_STATE_REFRESHING = REFRESH_STATE_REFRESHING
ns.REFRESH_STATE_RECOVERING = REFRESH_STATE_RECOVERING
ns.REFRESH_STATE_AUTH_EXPIRED = REFRESH_STATE_AUTH_EXPIRED
})()
