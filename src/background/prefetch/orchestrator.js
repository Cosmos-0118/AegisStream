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
  countGlobalInflightPrefetches,
  resolveBufferAdjustedPrefetchWindow,
  resolveBufferAdjustedGlobalCap,
  getTabBufferTier,
  isReactivePrefetchTab,
  isTwitchMediaUrl,
  noteTabPageUrl,
  getManifestUrlSignature,
  buildManifestSequenceIndex,
  resolveSegmentIndexInManifest
} = ns

const TIER_EMERGENCY = "emergency"
const TIER_AGGRESSIVE = "aggressive"

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
    tabState.rapidSeekUntil = now + constants.RAPID_SEEK_PAUSE_MS
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

function upsertPlaylistState(tabId, normalizedSegments) {
  if (!Array.isArray(normalizedSegments) || normalizedSegments.length === 0) return null
  const previous = state.playlistByTab.get(tabId)
  const { signatures: manifestSignatures, signatureToIndex } =
    buildManifestSequenceIndex(normalizedSegments)
  const playlistChanged =
    !previous?.segments ||
    previous.segments.length !== normalizedSegments.length ||
    previous.segments[0] !== normalizedSegments[0] ||
    previous.segments[previous.segments.length - 1] !==
      normalizedSegments[normalizedSegments.length - 1]

  let hasAnchor = false
  let anchorIndex = null
  let lastScheduledFromIndex = -1

  if (
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

  if (hasAnchor) {
    if (!playlistChanged && typeof previous?.lastScheduledFromIndex === "number") {
      lastScheduledFromIndex = previous.lastScheduledFromIndex
    } else {
      lastScheduledFromIndex = -1
    }
  }

  const tabState = {
    segments: normalizedSegments,
    manifestSignatures,
    signatureToIndex,
    updatedAt: Date.now(),
    hasAnchor,
    anchorIndex,
    lastScheduledFromIndex,
    lastScheduledAt: previous?.lastScheduledAt || 0,
    lastSkipLogAt: previous?.lastSkipLogAt || 0,
    highChurnMode: previous?.highChurnMode === true,
    prefetchCooldownUntil: Number(previous?.prefetchCooldownUntil || 0),
    playlistRefreshedAt: playlistChanged
      ? Date.now()
      : Number(previous?.playlistRefreshedAt || 0),
    recentAnchorChanges: playlistChanged ? [] : previous?.recentAnchorChanges || [],
    rapidSeekUntil: playlistChanged ? 0 : Number(previous?.rapidSeekUntil || 0),
    lastKnownSyncAt: previous?.lastKnownSyncAt || 0,
    lastKnownSyncSignature: previous?.lastKnownSyncSignature || ""
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

function maybeRequestPrefetchForTab(tabId, segments, startIndex, source) {
  if (isReactivePrefetchTab(tabId)) {
    addLog("DEBUG", `Reactive media mode: forward prefetch disabled (${source}, tab ${tabId})`)
    return
  }
  requestPrefetchForTab(tabId, segments, startIndex, source)
}

function resolveEffectivePrefetchWindow(tabId) {
  if (isReactivePrefetchTab(tabId)) return 0
  const baseWindow = Math.max(1, Number(state.settings.prefetchWindow) || 1)
  const jumps = getAnchorJumpCount(tabId)
  let windowSize = baseWindow
  if (jumps >= constants.PREFETCH_TAB_BURST_THRESHOLD) {
    windowSize = Math.min(baseWindow, constants.PREFETCH_BURST_WINDOW_CAP)
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

  state.inflightPrefetches.delete(normalizedUrl)

  if (success) {
    state.failedPrefetches.delete(normalizedUrl)
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

  if (effectiveWindow < state.settings.prefetchWindow && tabState.highChurnMode !== true) {
    tabState.highChurnMode = true
    addLog(
      "INFO",
      `High seek churn detected on tab ${tabId}; temporarily reducing prefetch window to ${effectiveWindow}`
    )
  } else if (effectiveWindow >= state.settings.prefetchWindow && tabState.highChurnMode === true) {
    tabState.highChurnMode = false
    addLog(
      "INFO",
      `Seek churn normalized on tab ${tabId}; restoring prefetch window to ${state.settings.prefetchWindow}`
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
  const batchInflightCap =
    tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE
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
    tabState.lastScheduledFromIndex = clampedStartIndex
    tabState.lastScheduledAt = now
    tabState.updatedAt = now
    return
  }

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
}

function requestPrefetchForTab(tabId, segments, startIndex = 0, source = "anchor") {
  if (!Array.isArray(segments) || segments.length === 0) return
  if (!isTabEligibleForPrefetch(tabId)) return

  const existing = state.pendingPrefetchByTab.get(tabId)
  if (existing?.timerId) {
    clearTimeout(existing.timerId)
  }

  const queuedAt = existing?.queuedAt || Date.now()
  const clampedStartIndex = Math.max(0, Number(startIndex) || 0)
  const tabState = state.playlistByTab.get(tabId)
  const pendingSnapshot = {
    segments,
    startIndex: clampedStartIndex,
    source,
    queuedAt
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
      { source: pending.source }
    )
  }, constants.PREFETCH_BATCH_DEBOUNCE_MS)

  state.pendingPrefetchByTab.set(tabId, {
    timerId,
    source,
    startIndex: clampedStartIndex,
    segments,
    queuedAt
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
  chrome.tabs
    .sendMessage(tabId, { type: "AegisStream:KnownSegments", urls: segments })
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
        const variants = parsed.variants.slice(0, constants.MAX_MASTER_VARIANTS_TO_SCAN)
        await Promise.all(
          variants.map((variantUrl) => parseAndPrefetchFromPlaylist(tabId, variantUrl, depth + 1))
        )
        return
      }
      bumpActivity("playlistsDetected", 1)
      const tabState = upsertPlaylistState(tabId, normalizeSegments(parsed.segments))
      if (!tabState?.segments?.length) {
        addLog("WARN", `HLS media playlist had 0 segments: ${normalizedPlaylistUrl.slice(-60)}`)
        return
      }
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

async function parsePlaylistContentForTab(tabId, playlistUrl, text, pageUrl = null) {
  if (!text || !tabId) return
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
        addLog("INFO", `Master playlist with ${parsed.variants.length} variants — waiting for page to load variant playlists`)
        return
      }
      bumpActivity("playlistsDetected", 1)
      if (!parsed.segments.length) {
        addLog("WARN", `HLS media playlist had 0 segments: ${normalizedUrl.slice(-60)}`)
        return
      }
      const tabState = upsertPlaylistState(tabId, normalizeSegments(parsed.segments))
      if (!tabState?.segments?.length) {
        addLog("WARN", `HLS media playlist had 0 usable segments: ${normalizedUrl.slice(-60)}`)
        return
      }
      syncKnownSegmentsToPage(tabId, tabState.segments)
      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        addLog("INFO", `Captured HLS refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
        maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "captured-playlist")
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
    const tabState = upsertPlaylistState(tabId, normalizeSegments(segments))
    if (!tabState?.segments?.length) return
    syncKnownSegmentsToPage(tabId, tabState.segments)
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      addLog("INFO", `Captured DASH refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
      maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "captured-playlist")
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
  const chunkIndex = resolveSegmentIndexInManifest(normalizedChunkUrl, tabState)
  if (typeof chunkIndex !== "number") return

  const hadAnchor = tabState.hasAnchor === true
  const previousAnchorIndex = tabState.anchorIndex
  tabState.hasAnchor = true
  tabState.anchorIndex = chunkIndex
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
    if (chunkIndex < previousAnchorIndex) {
      tabState.lastScheduledFromIndex = -1
    }
    if (playlistJustRefreshed) {
      addLog(
        "INFO",
        `Playlist reset anchor ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId}); skipping seek-churn handling`
      )
    } else {
      noteAnchorJump(tabId)
      applyAnchorJumpCooldown(tabState, previousAnchorIndex, chunkIndex)
      addLog("INFO", `Player anchor jumped from ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId})`)
    }
  }
  if (
    isTabEligibleForPrefetch(tabId) &&
    !isTabInAnchorCooldown(tabState) &&
    !isTabInRapidSeek(tabState)
  ) {
    maybeRequestPrefetchForTab(tabId, tabState.segments, chunkIndex + 1, "chunk-observed")
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
ns.observeChunkFromWebRequest = observeChunkFromWebRequest
ns.isTabInRapidSeek = isTabInRapidSeek
ns.schedulePrefetch = schedulePrefetch
ns.requestPrefetchForTab = requestPrefetchForTab
ns.maybeRequestPrefetchForTab = maybeRequestPrefetchForTab
ns.syncKnownSegmentsToPage = syncKnownSegmentsToPage
ns.updatePrefetchOutcome = updatePrefetchOutcome
})()
