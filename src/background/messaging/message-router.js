(() => {
var ns = (self.AegisBackground ||= {})
const {
  constants,
  state,
  addLog,
  sanitizeSettings,
  resetStats,
  stripHash,
  isUmpCacheKey,
  extractMessageBytes,
  arrayBufferToBase64,
  cacheChunk,
  resolveCachedChunk,
  clearCacheStores,
  rememberUmpLookupKey,
  maybeLogUmpHealthSummary,
  handleRuntimeMetric,
  bumpActivity,
  bumpLookupMetric,
  recordCacheServeHit,
  recordCacheLookupMiss,
  buildDisplayStats,
  refreshCacheEntryCount,
  enqueueStoreWrite,
  parseAndPrefetchFromPlaylist,
  parsePlaylistContentForTab,
  handleChunkObserved,
  isTabInRapidSeek,
  syncKnownSegmentsToPage,
  maybeRequestPrefetchForTab,
  noteTabPageUrl,
  noteTwitchAuthFromUrl,
  updatePrefetchOutcome,
  noteTabPrefetchFailure,
  noteManifestRefreshFailed,
  computeAdaptiveCachePolicy,
  syncPerformanceGemsFromSettings,
  fetchExtensionResponse,
  pumpResponseBody,
  headersToObject,
  isExpectedAbortError,
  bumpExtensionFetchLifecycle,
  registerActiveExtensionFetch,
  releaseActiveExtensionFetch,
  abortActiveExtensionFetch,
  startExtensionFetchLeakMonitor,
  recordLayoutAssets,
  sanitizeRecordedAssetsFromPage,
  armHeaderHintsForUrl,
  stopExtensionActivityOnTabs,
  broadcastSettingsToTabs
} = ns

const playlistDiscoverThrottleAt = new Map()
const layoutRecordLogAt = new Map()

function shouldLogLayoutRecord(origin, pathname, reason) {
  const key = `${origin}|${pathname}|${reason}`
  const now = Date.now()
  const last = Number(layoutRecordLogAt.get(key) || 0)
  if (now - last < 2500) return false
  layoutRecordLogAt.set(key, now)
  return true
}

function shouldThrottlePlaylistDiscover(url) {
  const key = stripHash(url)
  if (!key) return true
  const now = Date.now()
  const last = Number(playlistDiscoverThrottleAt.get(key) || 0)
  if (now - last < 4000) return true
  playlistDiscoverThrottleAt.set(key, now)
  if (playlistDiscoverThrottleAt.size > 500) {
    const cutoff = now - 60_000
    for (const [entryKey, ts] of playlistDiscoverThrottleAt.entries()) {
      if (ts < cutoff) playlistDiscoverThrottleAt.delete(entryKey)
    }
  }
  return false
}

function sendExtensionFetchChunk(tabId, requestId, index, chunkBase64) {
  return chrome.tabs
    .sendMessage(tabId, {
      type: "AegisStream:ExtensionFetchChunk",
      requestId,
      index,
      chunkBase64
    })
    .catch(() => {})
}

function sendExtensionFetchEnd(tabId, requestId, payload) {
  return chrome.tabs
    .sendMessage(tabId, {
      type: "AegisStream:ExtensionFetchEnd",
      requestId,
      ...payload
    })
    .catch(() => {})
}

function handleExtensionFetch(message, sendResponse, sender) {
  const tabId = sender?.tab?.id
  const requestId = message.requestId
  const source = message.source || "extension-fetch"

  ;(async () => {
    if (!tabId || !requestId) {
      sendResponse({ ok: false, error: "missing-tab-or-request-id" })
      return
    }

    let metaSent = false
    const controller = new AbortController()
    registerActiveExtensionFetch(requestId, {
      controller,
      startedAt: Date.now(),
      tabId,
      source
    })
    bumpExtensionFetchLifecycle(source, "started")

    try {
      const bodyBytes = extractMessageBytes(message)
      noteTwitchAuthFromUrl(tabId, message.url)
      const response = await fetchExtensionResponse(
        message.url,
        message.method || "GET",
        message.headers || {},
        bodyBytes,
        { tabId, signal: controller.signal, source }
      )

      sendResponse({
        ok: true,
        streaming: true,
        statusCode: response.status,
        headers: headersToObject(response.headers)
      })
      metaSent = true

      await pumpResponseBody(response, async (index, bytes) => {
        const chunkBase64 = arrayBufferToBase64(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        )
        if (!chunkBase64) return
        await sendExtensionFetchChunk(tabId, requestId, index, chunkBase64)
      })

      await sendExtensionFetchEnd(tabId, requestId, { ok: true })
      bumpExtensionFetchLifecycle(source, "completed")
    } catch (err) {
      if (isExpectedAbortError(err)) {
        bumpExtensionFetchLifecycle(source, "aborted")
        return
      }
      bumpExtensionFetchLifecycle(source, "failed")
      const msg = err?.message || "extension fetch failed"
      if (!metaSent) {
        sendResponse({ ok: false, error: msg })
        return
      }
      await sendExtensionFetchEnd(tabId, requestId, { ok: false, error: msg })
    } finally {
      releaseActiveExtensionFetch(requestId)
    }
  })()
}

function handleExtensionFetchAbort(message) {
  abortActiveExtensionFetch(message.requestId)
}

function handleCacheLookup(message, sendResponse, tabId = null) {
  ;(async () => {
    const method = (message.method || "GET").toUpperCase()
    const hasRange = Boolean(message.hasRange)
    const lookupUrl = stripHash(message.url)
    const isUmpLookup = isUmpCacheKey(lookupUrl)
    const tabState = Number.isFinite(tabId) ? state.playlistByTab.get(tabId) : null
    const rapidSeek = isTabInRapidSeek(tabState)
    if (
      method !== "GET" ||
      hasRange ||
      !lookupUrl ||
      !state.settings.enabled ||
      !state.settings.serveFromCache
    ) {
      sendResponse({ ok: true, hit: false, skipped: true })
      return
    }

    bumpLookupMetric("cacheLookups", lookupUrl, 1)
    if (isUmpLookup) bumpActivity("youtubeUmpLookups", 1)

    const isFirstSeenUmpKey = isUmpLookup && !state.umpLookupSeenAt.has(lookupUrl)
    const stillInWarmupWindow =
      isUmpLookup &&
      (state.stats.youtubeUmpLookups || 0) <= constants.UMP_WARMUP_LOOKUP_LIMIT &&
      (state.stats.youtubeUmpLookupHits || 0) === 0

    const resolved = await resolveCachedChunk(lookupUrl)
    if (!resolved?.item) {
      if (isUmpLookup) {
        if (isFirstSeenUmpKey && stillInWarmupWindow) {
          bumpLookupMetric("cacheWarmups", lookupUrl, 1)
          bumpActivity("youtubeUmpWarmups", 1)
        } else if (!rapidSeek) {
          recordCacheLookupMiss(lookupUrl)
        }
        if (isFirstSeenUmpKey) {
          bumpActivity("youtubeUmpLookupMisses", 1)
          rememberUmpLookupKey(lookupUrl)
        }
        maybeLogUmpHealthSummary()
      } else if (!rapidSeek) {
        recordCacheLookupMiss(lookupUrl)
      }
      sendResponse({
        ok: true,
        hit: false,
        warmup: isUmpLookup && isFirstSeenUmpKey && stillInWarmupWindow
      })
      return
    }

    recordCacheServeHit(lookupUrl)
    if (isUmpLookup) {
      bumpActivity("youtubeUmpLookupHits", 1)
      rememberUmpLookupKey(lookupUrl)
      maybeLogUmpHealthSummary()
    }
    if (typeof ns.recordSpeculativeUsed === "function") {
      ns.recordSpeculativeUsed(
        lookupUrl,
        resolved.item.bytes?.byteLength || 0,
        tabId
      )
    }
    const hitLabel = isUmpLookup ? "UMP cache HIT" : resolved.via === "alias" ? "Cache HIT via alias" : "Cache HIT"
    addLog("INFO", `${hitLabel}: ${lookupUrl.slice(-60)}`)
    const bytesBase64 = arrayBufferToBase64(resolved.item.bytes)
    if (!bytesBase64) {
      addLog("ERROR", `Cache hit serialization failed: ${lookupUrl.slice(-60)}`)
      sendResponse({ ok: false, hit: false, error: "serialize-failed" })
      return
    }
    sendResponse({
      ok: true,
      hit: true,
      contentType: resolved.item.contentType,
      bytesBase64,
      byteLength: resolved.item.bytes.byteLength || 0
    })
  })().catch(() => {
    sendResponse({ ok: false, hit: false })
  })
}

function handleStoreChunk(message, sendResponse) {
  ;(async () => {
    if (!state.settings.enabled) {
      sendResponse({ ok: false, error: "disabled" })
      return
    }
    const method = (message.method || "GET").toUpperCase()
    const hasRange = Boolean(message.hasRange)
    const status = Number(message.status || 0)
    const storeUrl = stripHash(message.url)
    const bytes = extractMessageBytes(message)
    if (method !== "GET" || hasRange || status === 206) {
      sendResponse({ ok: true, skipped: true })
      return
    }
    if (!storeUrl || !bytes || typeof bytes.byteLength !== "number" || bytes.byteLength <= 0) {
      addLog(
        "WARN",
        `StoreChunk rejected (invalid payload): url=${Boolean(storeUrl)} bytes=${typeof bytes?.byteLength === "number" ? bytes.byteLength : "none"} method=${method} range=${hasRange} status=${status}`
      )
      sendResponse({ ok: false, skipped: true, error: "invalid-payload" })
      return
    }
    const storeResult = await enqueueStoreWrite(() =>
      cacheChunk(storeUrl, message.contentType, bytes)
    )
    if (!storeResult?.ok) {
      sendResponse({
        ok: false,
        skipped: true,
        error: storeResult?.error || "cache-write-failed"
      })
      return
    }
    if (!storeResult.stored) {
      sendResponse({ ok: true, duplicate: true })
      return
    }
    bumpActivity("cachedChunks", 1)
    if (isUmpCacheKey(storeUrl)) {
      bumpActivity("youtubeUmpChunks", 1)
      rememberUmpLookupKey(storeUrl)
      maybeLogUmpHealthSummary()
    }
    void refreshCacheEntryCount(true).catch(() => {})
    addLog(
      "INFO",
      `Cached chunk from page (${(bytes.byteLength / 1024).toFixed(1)} KB): ${storeUrl.slice(-60)}`
    )
    sendResponse({ ok: true })
  })().catch((e) => {
    addLog("ERROR", `StoreChunk exception: ${e.message}`)
    sendResponse({ ok: false, error: "exception" })
  })
}

function registerMessageRouter() {
  const { wakeBackgroundEngine } = ns
  if (typeof startExtensionFetchLeakMonitor === "function") {
    startExtensionFetchLeakMonitor()
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void wakeBackgroundEngine()
    if (!message?.type) return false
  switch (message.type) {
    case "AegisStream:ExtensionFetch":
      handleExtensionFetch(message, sendResponse, sender)
      return true
    case "AegisStream:ExtensionFetchAbort":
      handleExtensionFetchAbort(message)
      return false
    case "AegisStream:GetSettings":
      ;(async () => {
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, settings: state.settings, stats })
      })().catch(() => {
        sendResponse({ ok: true, settings: state.settings, stats: state.stats })
      })
      return true
    case "AegisStream:GetStats":
      ;(async () => {
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, stats })
      })().catch(() => {
        sendResponse({ ok: true, stats: state.stats })
      })
      return true
    case "AegisStream:ResetStats":
      resetStats()
      addLog("INFO", "Activity stats reset by user")
      ;(async () => {
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, stats })
      })().catch(() => {
        sendResponse({ ok: true, stats: state.stats })
      })
      return true
    case "AegisStream:GetLogs":
      sendResponse({ ok: true, logs: state.logs })
      return true
    case "AegisStream:BridgeReady": {
      const tabId = sender?.tab?.id
      if (tabId) {
        if (sender?.tab?.url) noteTabPageUrl(tabId, sender.tab.url)
        const now = Date.now()
        const lastHeartbeat = Number(state.bridgeHeartbeatByTab.get(tabId) || 0)
        state.bridgeHeartbeatByTab.set(tabId, now)
        if (message.reason === "visible" && now - lastHeartbeat < 1500) {
          sendResponse({ ok: true })
          return true
        }
        const tabState = state.playlistByTab.get(tabId)
        if (state.settings.enabled && tabState?.segments?.length) {
          syncKnownSegmentsToPage(tabId, tabState.segments, { reason: message.reason || "bridge-ready" })
          if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
            maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "bridge-ready")
          }
        }
      }
      sendResponse({ ok: true, settings: state.settings })
      return true
    }
    case "AegisStream:ClearLogs":
      state.logs = []
      addLog("INFO", "Logs cleared by user")
      sendResponse({ ok: true })
      return true
    case "AegisStream:UpdateSettings": {
      const wasEnabled = state.settings.enabled !== false
      const wasPrefetchEnabled = state.settings.prefetchEnabled !== false
      state.settings = sanitizeSettings({ ...state.settings, ...(message.payload || {}) })
      addLog(
        "INFO",
        `Settings updated: enabled=${state.settings.enabled}, prefetch=${state.settings.prefetchEnabled}, cache=${state.settings.serveFromCache}, window=${state.settings.prefetchWindow}`
      )
      void computeAdaptiveCachePolicy(true).catch(() => {})
      void syncPerformanceGemsFromSettings().catch(() => {})
      const disabledNow = state.settings.enabled === false
      const prefetchOffNow = state.settings.prefetchEnabled === false
      const shouldStopActivity =
        (wasEnabled && disabledNow) ||
        (wasPrefetchEnabled && prefetchOffNow) ||
        disabledNow
      if (shouldStopActivity) {
        void stopExtensionActivityOnTabs(state.settings, disabledNow ? "disabled" : "prefetch-off")
      } else {
        void broadcastSettingsToTabs(state.settings)
      }
      chrome.storage.local
        .set({ settings: state.settings })
        .then(() => sendResponse({ ok: true, settings: state.settings }))
        .catch((e) => {
          addLog("ERROR", `Failed to persist settings: ${e.message}`)
          sendResponse({ ok: false })
        })
      return true
    }
    case "AegisStream:CacheLookup":
      handleCacheLookup(message, sendResponse, sender?.tab?.id)
      return true
    case "AegisStream:StoreChunk":
      handleStoreChunk(message, sendResponse)
      return true
    case "AegisStream:ClearCache":
      ;(async () => {
        await clearCacheStores()
        state.playlistByTab.clear()
        state.bridgeHeartbeatByTab.clear()
        state.tabPageHostByTab?.clear()
        state.tabPageUrlFingerprintByTab?.clear()
        state.twitchSessionByTab?.clear()
        state.tabAnchorJumps.clear()
        for (const pending of state.pendingPrefetchByTab.values()) {
          if (pending?.timerId) clearTimeout(pending.timerId)
        }
        state.pendingPrefetchByTab.clear()
        state.inflightPrefetches.clear()
        state.failedPrefetches.clear()
        state.umpLookupSeenAt.clear()
        await computeAdaptiveCachePolicy(true).catch(() => {})
        resetStats()
        await refreshCacheEntryCount(true)
        addLog("INFO", "Cache and stats cleared by user")
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, stats })
      })().catch(() => {
        sendResponse({ ok: false })
      })
      return true
    case "AegisStream:PlaylistDiscovered": {
      const tabId = sender?.tab?.id
      if (sender?.tab?.url) noteTabPageUrl(tabId, sender.tab.url)
      if (tabId && message.url && !shouldThrottlePlaylistDiscover(message.url)) {
        addLog("DEBUG", `Playlist URL discovered in DOM: ${message.url.slice(-80)}`)
        void parseAndPrefetchFromPlaylist(tabId, message.url)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PlaylistContent": {
      const tabId = sender?.tab?.id
      if (sender?.tab?.url) noteTabPageUrl(tabId, sender.tab.url)
      if (tabId && message.url && message.text && state.settings.enabled) {
        addLog(
          "INFO",
          `Playlist content captured from page (${message.text.length} chars): ${message.url.slice(-80)}`
        )
        void parsePlaylistContentForTab(tabId, message.url, message.text, {
          pageUrl: message.pageUrl || null,
          generation: message.generation
        })
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PlaylistRefreshFailed": {
      const tabId = sender?.tab?.id
      if (tabId) {
        noteManifestRefreshFailed(tabId, message.generation, message.status)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:CacheServeHit": {
      if (message.url) {
        recordCacheServeHit(message.url)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:SpeculativeRegister": {
      if (typeof ns.registerSpeculativePrefetch === "function" && message.url) {
        ns.registerSpeculativePrefetch({
          url: message.url,
          tabId: sender?.tab?.id,
          source: message.source || "cross-itag",
          fromItag: message.fromItag || null,
          toItag: message.toItag || null,
          fromRung: message.fromRung || null,
          toRung: message.toRung || null
        })
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PrefetchResult":
      ;(async () => {
        const tabId = sender?.tab?.id
        const skipped = message.skipped
        if (
          skipped === "already-inflight" ||
          skipped === "tab-inactive" ||
          skipped === "tab-hidden" ||
          skipped === "stale-queue"
        ) {
          updatePrefetchOutcome(message.url, true)
          sendResponse({ ok: true })
          return
        }
        if (message.success) {
          updatePrefetchOutcome(message.url, true, "unknown", { tabId })
          bumpActivity("prefetched", 1)
          if (typeof ns.recordSpeculativeCompleted === "function") {
            ns.recordSpeculativeCompleted(message.url, message.size, true)
          }
          if (message.source === "cross-itag") {
            bumpActivity("youtubeCrossItagPrefetch", 1)
          }
          const sizeKB = message.size ? `(${(message.size / 1024).toFixed(1)} KB)` : ""
          addLog("INFO", `Prefetched ${sizeKB}: ${(message.url || "").slice(-80)}`)
          sendResponse({ ok: true })
          return
        }

        const lookupUrl = stripHash(message.url)
        if (lookupUrl) {
          const existing = await resolveCachedChunk(lookupUrl).catch(() => null)
          if (existing?.item) {
            updatePrefetchOutcome(message.url, true)
            sendResponse({ ok: true })
            return
          }
        }

        const errorText = message.error || "unknown"
        const transient =
          message.transient === true ||
          /tab-hidden|tab-not-active|runtime|timeout|serialize|message port/i.test(errorText)
        if (typeof ns.recordSpeculativeCompleted === "function") {
          ns.recordSpeculativeCompleted(message.url, 0, false)
        }
        const outcome = updatePrefetchOutcome(message.url, false, errorText, { transient })
        if (Number.isFinite(tabId)) {
          noteTabPrefetchFailure(tabId, errorText, {
            authFailure: message.authFailure === true,
            rateLimit: message.rateLimit === true
          })
        }
        bumpActivity("prefetchFailed", 1)
        const retryAfterSec = Math.max(1, Math.ceil((outcome.retryAfter - Date.now()) / 1000))
        const shouldLogFailure =
          outcome.attempts <= 2 ||
          outcome.attempts % 4 === 0 ||
          errorText === "delegate-failed"
        if (shouldLogFailure) {
          addLog(
            transient ? "WARN" : "ERROR",
            `Prefetch failed (attempt ${outcome.attempts}, retry in ${retryAfterSec}s): ${errorText} — ${(message.url || "").slice(-80)}`
          )
        }
        sendResponse({ ok: true })
      })().catch(() => {
        sendResponse({ ok: true })
      })
      return true
    case "AegisStream:ChunkObserved": {
      const tabId = sender?.tab?.id
      if (!state.settings.enabled) {
        sendResponse({ ok: true, skipped: true })
        return true
      }
      if (tabId && message.url) {
        void handleChunkObserved(tabId, message.url)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:RuntimeMetric":
      handleRuntimeMetric(message, sender)
      sendResponse({ ok: true })
      return true
    case "AegisStream:DebugLog":
      addLog(message.level || "DEBUG", `[Page Bridge] ${message.msg}`)
      sendResponse({ ok: true })
      return true
    case "AegisStream:RecordLayoutAssets": {
      ;(async () => {
        if (!state.settings.enabled) {
          sendResponse({ ok: false, error: "disabled" })
          return
        }
        const assets = sanitizeRecordedAssetsFromPage(message.assets)
        const saved = await recordLayoutAssets(message.origin, message.pathname, assets)
        if (saved.length > 0 && shouldLogLayoutRecord(message.origin, message.pathname, message.reason)) {
          addLog(
            "DEBUG",
            `Layout assets recorded (${saved.length}, ${message.reason || "unknown"}) for ${String(message.origin || "").slice(0, 48)}${message.pathname || "/"}`
          )
        }
        sendResponse({ ok: true, count: saved.length })
      })().catch((e) => {
        sendResponse({ ok: false, error: e.message })
      })
      return true
    }
    case "AegisStream:ArmHeaderHints": {
      ;(async () => {
        const result = await armHeaderHintsForUrl(message.targetUrl, message.reason || "hover")
        sendResponse({ ok: result.ok === true, ...result })
      })().catch((e) => {
        sendResponse({ ok: false, error: e.message })
      })
      return true
    }
    default:
      return false
  }
})

}

ns.registerMessageRouter = registerMessageRouter
})()
