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
  resolveCachedChunk
} = ns

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

function buildIndexByUrl(segments) {
  const indexByUrl = new Map()
  segments.forEach((segment, index) => {
    const keys = buildCacheKeyVariants(segment)
    for (const key of keys) {
      if (!indexByUrl.has(key)) {
        indexByUrl.set(key, index)
        continue
      }
      const existing = indexByUrl.get(key)
      if (typeof existing === "number" && existing !== index) {
        // Mark ambiguous keys so anchor matching won't bounce to wrong indices.
        indexByUrl.set(key, -1)
      }
    }
  })
  return indexByUrl
}

function upsertPlaylistState(tabId, normalizedSegments) {
  if (!Array.isArray(normalizedSegments) || normalizedSegments.length === 0) return null
  const previous = state.playlistByTab.get(tabId)
  const indexByUrl = buildIndexByUrl(normalizedSegments)
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
      for (const key of buildCacheKeyVariants(previousAnchorUrl)) {
        const idx = indexByUrl.get(key)
        if (typeof idx === "number") {
          hasAnchor = true
          anchorIndex = idx
          break
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
    indexByUrl,
    updatedAt: Date.now(),
    hasAnchor,
    anchorIndex,
    lastScheduledFromIndex,
    lastScheduledAt: previous?.lastScheduledAt || 0,
    lastSkipLogAt: previous?.lastSkipLogAt || 0,
    highChurnMode: previous?.highChurnMode === true,
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

function resolveEffectivePrefetchWindow(tabId) {
  const baseWindow = Math.max(1, Number(state.settings.prefetchWindow) || 1)
  const jumps = getAnchorJumpCount(tabId)
  if (jumps >= constants.PREFETCH_TAB_BURST_THRESHOLD) {
    return Math.min(baseWindow, constants.PREFETCH_BURST_WINDOW_CAP)
  }
  return baseWindow
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

async function schedulePrefetch(tabId, segments, startIndex = 0, options = {}) {
  if (!state.settings.enabled || !state.settings.prefetchEnabled) return
  const normalized = normalizeSegments(segments)
  if (!normalized.length) return
  const tabState = upsertPlaylistState(tabId, normalized)
  if (!tabState) return

  const force = Boolean(options.force)
  const now = Date.now()
  const clampedStartIndex = Math.max(0, Math.min(startIndex, normalized.length))

  if (shouldSkipDuplicateSchedule(tabState, clampedStartIndex, now, force)) {
    return
  }

  const effectiveWindow = resolveEffectivePrefetchWindow(tabId)
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

  if (!uncached.length) {
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
  for (const url of uncached) {
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
    `Scheduling prefetch of ${uncached.length} chunks for tab ${tabId} (from index ${clampedStartIndex})`
  )
  tabState.lastScheduledFromIndex = clampedStartIndex
  tabState.lastScheduledAt = now
  tabState.updatedAt = now

  const delegated = await delegatePrefetchToPage(tabId, uncached)
  if (!delegated) {
    for (const url of uncached) {
      updatePrefetchOutcome(url, false, "delegate-failed")
    }
  }
}

function requestPrefetchForTab(tabId, segments, startIndex = 0, source = "anchor") {
  if (!Array.isArray(segments) || segments.length === 0) return

  const existing = state.pendingPrefetchByTab.get(tabId)
  if (existing?.timerId) {
    clearTimeout(existing.timerId)
  }

  const timerId = setTimeout(() => {
    const pending = state.pendingPrefetchByTab.get(tabId)
    if (!pending) return
    state.pendingPrefetchByTab.delete(tabId)
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
    startIndex: Math.max(0, Number(startIndex) || 0),
    segments,
    queuedAt: Date.now()
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
    now - Number(tabState.lastKnownSyncAt || 0) < 5000
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
  try {
    addLog("INFO", `Fetching playlist (depth=${depth}): ${normalizedPlaylistUrl.slice(-100)}`)
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
        state.stats.playlistsDetected += 1
        if (depth >= 1) return
        const variants = parsed.variants.slice(0, constants.MAX_MASTER_VARIANTS_TO_SCAN)
        await Promise.all(
          variants.map((variantUrl) => parseAndPrefetchFromPlaylist(tabId, variantUrl, depth + 1))
        )
        return
      }
      state.stats.playlistsDetected += 1
      const tabState = upsertPlaylistState(tabId, normalizeSegments(parsed.segments))
      if (!tabState?.segments?.length) {
        addLog("WARN", `HLS media playlist had 0 segments: ${normalizedPlaylistUrl.slice(-60)}`)
        return
      }
      syncKnownSegmentsToPage(tabId, tabState.segments)
      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        addLog("INFO", `Playlist refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
        requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "playlist-refresh")
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
    state.stats.playlistsDetected += 1
    addLog("INFO", `DASH manifest parsed: ${segments.length} segments`)
    const tabState = upsertPlaylistState(tabId, normalizeSegments(segments))
    if (!tabState?.segments?.length) return
    syncKnownSegmentsToPage(tabId, tabState.segments)
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      addLog("INFO", `DASH playlist refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
      requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "playlist-refresh")
    } else {
      addLog("INFO", "Awaiting player segment request to anchor DASH prefetch (JIT mode)")
    }
  } catch (e) {
    addLog("ERROR", `Playlist error: ${e.message}`)
  }
}

async function parsePlaylistContentForTab(tabId, playlistUrl, text, pageUrl = null) {
  if (!text || !tabId) return
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
        state.stats.playlistsDetected += 1
        addLog("INFO", `Master playlist with ${parsed.variants.length} variants — waiting for page to load variant playlists`)
        return
      }
      state.stats.playlistsDetected += 1
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
        requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "captured-playlist")
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
    state.stats.playlistsDetected += 1
    addLog("INFO", `DASH parsed from page capture: ${segments.length} segments`)
    if (!segments.length) return
    const tabState = upsertPlaylistState(tabId, normalizeSegments(segments))
    if (!tabState?.segments?.length) return
    syncKnownSegmentsToPage(tabId, tabState.segments)
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      addLog("INFO", `Captured DASH refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
      requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "captured-playlist")
    } else {
      addLog("INFO", "Awaiting player segment request to anchor captured DASH prefetch (JIT mode)")
    }
  } catch (e) {
    addLog("ERROR", `Error parsing captured playlist: ${e.message}`)
  }
}

async function handleChunkObserved(tabId, chunkUrl) {
  const normalizedChunkUrl = stripHash(chunkUrl)
  if (!normalizedChunkUrl) return
  state.stats.chunksObserved += 1
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length || !tabState.indexByUrl) return
  tabState.updatedAt = Date.now()
  const candidateKeys = buildCacheKeyVariants(normalizedChunkUrl)
  let chunkIndex = null
  for (const key of candidateKeys) {
    const idx = tabState.indexByUrl.get(key)
    if (idx === -1) continue
    if (typeof idx === "number") {
      chunkIndex = idx
      break
    }
  }
  if (typeof chunkIndex !== "number") return

  const hadAnchor = tabState.hasAnchor === true
  const previousAnchorIndex = tabState.anchorIndex
  tabState.hasAnchor = true
  tabState.anchorIndex = chunkIndex
  if (!hadAnchor) {
    tabState.lastScheduledFromIndex = -1
    addLog("INFO", `Player anchor acquired at segment index ${chunkIndex} (tab ${tabId})`)
  } else if (
    typeof previousAnchorIndex === "number" &&
    Math.abs(chunkIndex - previousAnchorIndex) > Math.max(state.settings.prefetchWindow * 2, 8)
  ) {
    noteAnchorJump(tabId)
    if (chunkIndex < previousAnchorIndex) {
      tabState.lastScheduledFromIndex = -1
    }
    addLog("INFO", `Player anchor jumped from ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId})`)
  }
  requestPrefetchForTab(tabId, tabState.segments, chunkIndex + 1, "chunk-observed")
}

ns.pruneRuntimeState = pruneRuntimeState
ns.parseAndPrefetchFromPlaylist = parseAndPrefetchFromPlaylist
ns.parsePlaylistContentForTab = parsePlaylistContentForTab
ns.handleChunkObserved = handleChunkObserved
ns.schedulePrefetch = schedulePrefetch
ns.requestPrefetchForTab = requestPrefetchForTab
ns.syncKnownSegmentsToPage = syncKnownSegmentsToPage
ns.updatePrefetchOutcome = updatePrefetchOutcome
})()
