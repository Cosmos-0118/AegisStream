importScripts(
  "./background/config/constants.js",
  "./background/state/runtime-state.js",
  "./background/domain/url-playlist-utils.js",
  "./background/io/cache-db.js",
  "./background/io/store-queue.js",
  "./background/domain/activity-metrics.js",
  "./background/domain/telemetry.js",
  "./background/orchestration/tab-prefetch-policy.js",
  "./background/orchestration/buffer-prefetch-policy.js",
  "./background/orchestration/prefetch-orchestrator.js",
  "./background/io/extension-fetch.js"
)

const {
  constants,
  state,
  addLog,
  sanitizeSettings,
  resetStats,
  loadSettings,
  stripHash,
  isPlaylistUrl,
  isLikelyChunkUrl,
  isUmpCacheKey,
  extractMessageBytes,
  base64ToArrayBuffer,
  arrayBufferToBase64,
  cacheChunk,
  resolveCachedChunk,
  clearCacheStores,
  rememberUmpLookupKey,
  maybeLogUmpHealthSummary,
  handleRuntimeMetric,
  bumpActivity,
  bumpLookupMetric,
  buildDisplayStats,
  resetActivityMetrics,
  refreshCacheEntryCount,
  enqueueStoreWrite,
  refreshActivePrefetchTab,
  setActivePrefetchTab,
  pruneRuntimeState,
  parseAndPrefetchFromPlaylist,
  parsePlaylistContentForTab,
  handleChunkObserved,
  observeChunkFromWebRequest,
  isTabInRapidSeek,
  requestPrefetchForTab,
  syncKnownSegmentsToPage,
  updatePrefetchOutcome,
  computeAdaptiveCachePolicy,
  isTabEligibleForPrefetch,
  fetchExtensionResponse,
  pumpResponseBody,
  headersToObject
} = self.AegisBackground

const ISOLATED_BRIDGE_FILES = ["src/content/content-relay.js"]
const MAIN_BRIDGE_FILES = [
  "src/bridge/shared/range-buffer.js",
  "src/bridge/shared/youtube-ump-flags.js",
  "src/bridge/page/runtime/core.js",
  "src/bridge/page/runtime/buffer-health-monitor.js",
  "src/bridge/page/runtime/extension-fetch-client.js",
  "src/bridge/page/runtime/prefetch-video.js",
  "src/bridge/page/runtime/message-bridge.js",
  "src/bridge/page/domain/youtube-playlist.js",
  "src/bridge/page/interceptors/fetch.js",
  "src/bridge/page/interceptors/xhr.js",
  "src/bridge/page/main.js"
]
const YOUTUBE_MAIN_BRIDGE_FILES = ["src/content/youtube/kill-ump.js"]

function isInjectableHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url)
}

function isYouTubeUrl(url) {
  if (typeof url !== "string") return false
  try {
    const parsed = new URL(url)
    const host = parsed.hostname || ""
    return host === "youtube.com" || host.endsWith(".youtube.com")
  } catch {
    return false
  }
}

async function pingTabBridge(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "AegisStream:Ping" })
    return Boolean(response?.ok)
  } catch {
    return false
  }
}

async function ensureTabBridgeReady(tabId, reason = "unknown", force = false) {
  if (!tabId || tabId < 0) return false
  const now = Date.now()
  const lastHeartbeat = Number(state.bridgeHeartbeatByTab.get(tabId) || 0)
  if (!force && now - lastHeartbeat < constants.TAB_BRIDGE_RECHECK_MS) {
    return true
  }

  let tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return false
  }
  if (!isInjectableHttpUrl(tab?.url)) return false

  if (await pingTabBridge(tabId)) {
    state.bridgeHeartbeatByTab.set(tabId, now)
    return true
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ISOLATED_BRIDGE_FILES,
      world: "ISOLATED"
    })
    if (isYouTubeUrl(tab.url)) {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: YOUTUBE_MAIN_BRIDGE_FILES,
        world: "MAIN"
      })
    }
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: MAIN_BRIDGE_FILES,
      world: "MAIN"
    })

    state.bridgeHeartbeatByTab.set(tabId, Date.now())
    addLog("INFO", `Reinjected content bridge into tab ${tabId} (${reason})`)

    const tabState = state.playlistByTab.get(tabId)
    if (tabState?.segments?.length) {
      syncKnownSegmentsToPage(tabId, tabState.segments, { reason: `reinject:${reason}` })
      if (
        isTabEligibleForPrefetch(tabId) &&
        tabState.hasAnchor &&
        typeof tabState.anchorIndex === "number"
      ) {
        requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, `resume:${reason}`)
      }
    }
    return true
  } catch (e) {
    addLog("WARN", `Bridge reinjection skipped for tab ${tabId} (${reason}): ${e.message}`)
    return false
  }
}

async function bootstrapOpenTabs(reason = "bootstrap") {
  const force = reason === "installed"
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return
  }
  await Promise.allSettled(
    tabs
      .filter((tab) => isInjectableHttpUrl(tab.url))
      .map((tab) => ensureTabBridgeReady(tab.id, reason, force))
  )
}

async function initializeBackground(reason = "startup") {
  await loadSettings()
  await computeAdaptiveCachePolicy(true).catch(() => {})
  await refreshActivePrefetchTab()
  await bootstrapOpenTabs(reason)
}

void initializeBackground("startup")

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !state.settings.enabled) return
    pruneRuntimeState()
    const url = stripHash(details.url)
    if (!url) return
    if (isPlaylistUrl(url)) {
      addLog("INFO", `Playlist request detected via webRequest: ${url.slice(-80)}`)
      return
    }
    if (details.tabId !== state.activePrefetchTabId) return
    const tabState = state.playlistByTab.get(details.tabId)
    if (tabState?.segments?.length) {
      observeChunkFromWebRequest(details.tabId, url)
      return
    }
    if (isLikelyChunkUrl(url)) {
      observeChunkFromWebRequest(details.tabId, url)
    }
  },
  { urls: ["<all_urls>"] }
)

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || !state.settings.enabled) return
    const url = stripHash(details.url)
    if (!url) return
    const headers = details.responseHeaders || []
    for (const header of headers) {
      if (header.name.toLowerCase() !== "content-type") continue
      const ct = (header.value || "").toLowerCase()
      if (ct.includes("mpegurl") || ct.includes("x-mpegurl") || ct.includes("dash+xml")) {
        addLog("INFO", `Playlist detected via content-type (${ct}): ${url.slice(-80)}`)
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
)

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!state.settings.enabled || windowId === chrome.windows.WINDOW_ID_NONE) return
  void refreshActivePrefetchTab()
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.activePrefetchTabId === tabId) {
    state.activePrefetchTabId = null
    void refreshActivePrefetchTab()
  }
  state.playlistByTab.delete(tabId)
  state.bridgeHeartbeatByTab.delete(tabId)
  state.tabAnchorJumps.delete(tabId)
  const pending = state.pendingPrefetchByTab.get(tabId)
  if (pending?.timerId) clearTimeout(pending.timerId)
  state.pendingPrefetchByTab.delete(tabId)
  for (const [url, inflight] of state.inflightPrefetches.entries()) {
    if (inflight?.tabId === tabId) {
      state.inflightPrefetches.delete(url)
    }
  }
})

chrome.runtime.onInstalled.addListener(() => {
  addLog("INFO", "Extension installed/updated")
  void initializeBackground("installed")
})

chrome.runtime.onStartup.addListener(() => {
  addLog("INFO", "Browser started — loading settings")
  void initializeBackground("startup-event")
})

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!state.settings.enabled) return
  setActivePrefetchTab(tabId, "tab-activated")
  pruneRuntimeState()
  void ensureTabBridgeReady(tabId, "tab-activated", false).then((ready) => {
    if (!ready) return
    const tabState = state.playlistByTab.get(tabId)
    if (!tabState?.segments?.length) return
    syncKnownSegmentsToPage(tabId, tabState.segments, { reason: "tab-activated" })
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "tab-activated")
    }
  })
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    state.bridgeHeartbeatByTab.delete(tabId)
  }
  if (changeInfo.status !== "complete") return
  if (!isInjectableHttpUrl(tab?.url)) return

  void ensureTabBridgeReady(tabId, "tab-updated", false).then((ready) => {
    if (!ready) return
    const tabState = state.playlistByTab.get(tabId)
    if (!tabState?.segments?.length) return
    syncKnownSegmentsToPage(tabId, tabState.segments, { reason: "tab-updated" })
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "tab-updated")
    }
  })
})

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

  ;(async () => {
    if (!tabId || !requestId) {
      sendResponse({ ok: false, error: "missing-tab-or-request-id" })
      return
    }

    let metaSent = false
    try {
      const bodyBytes = extractMessageBytes(message)
      const response = await fetchExtensionResponse(
        message.url,
        message.method || "GET",
        message.headers || {},
        bodyBytes
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
    } catch (err) {
      const msg = err?.message || "extension fetch failed"
      if (!metaSent) {
        sendResponse({ ok: false, error: msg })
        return
      }
      await sendExtensionFetchEnd(tabId, requestId, { ok: false, error: msg })
    }
  })()
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
          bumpLookupMetric("cacheMisses", lookupUrl, 1)
        }
        if (isFirstSeenUmpKey) {
          bumpActivity("youtubeUmpLookupMisses", 1)
          rememberUmpLookupKey(lookupUrl)
        }
        maybeLogUmpHealthSummary()
      } else if (!rapidSeek) {
        bumpLookupMetric("cacheMisses", lookupUrl, 1)
      }
      sendResponse({
        ok: true,
        hit: false,
        warmup: isUmpLookup && isFirstSeenUmpKey && stillInWarmupWindow
      })
      return
    }

    bumpLookupMetric("cacheHits", lookupUrl, 1)
    if (isUmpLookup) {
      bumpActivity("youtubeUmpLookupHits", 1)
      rememberUmpLookupKey(lookupUrl)
      maybeLogUmpHealthSummary()
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false
  switch (message.type) {
    case "AegisStream:ExtensionFetch":
      handleExtensionFetch(message, sendResponse, sender)
      return true
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
        const now = Date.now()
        const lastHeartbeat = Number(state.bridgeHeartbeatByTab.get(tabId) || 0)
        state.bridgeHeartbeatByTab.set(tabId, now)
        if (message.reason === "visible" && now - lastHeartbeat < 1500) {
          sendResponse({ ok: true })
          return true
        }
        const tabState = state.playlistByTab.get(tabId)
        if (tabState?.segments?.length) {
          syncKnownSegmentsToPage(tabId, tabState.segments, { reason: message.reason || "bridge-ready" })
          if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
            requestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "bridge-ready")
          }
        }
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:ClearLogs":
      state.logs = []
      addLog("INFO", "Logs cleared by user")
      sendResponse({ ok: true })
      return true
    case "AegisStream:UpdateSettings":
      state.settings = sanitizeSettings({ ...state.settings, ...(message.payload || {}) })
      addLog(
        "INFO",
        `Settings updated: enabled=${state.settings.enabled}, prefetch=${state.settings.prefetchEnabled}, cache=${state.settings.serveFromCache}, window=${state.settings.prefetchWindow}`
      )
      void computeAdaptiveCachePolicy(true).catch(() => {})
      chrome.storage.local
        .set({ settings: state.settings })
        .then(() => sendResponse({ ok: true, settings: state.settings }))
        .catch((e) => {
          addLog("ERROR", `Failed to persist settings: ${e.message}`)
          sendResponse({ ok: false })
        })
      return true
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
      if (tabId && message.url) {
        addLog("INFO", `Playlist URL discovered in DOM: ${message.url.slice(-80)}`)
        void parseAndPrefetchFromPlaylist(tabId, message.url)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PlaylistContent": {
      const tabId = sender?.tab?.id
      if (tabId && message.url && message.text) {
        addLog(
          "INFO",
          `Playlist content captured from page (${message.text.length} chars): ${message.url.slice(-80)}`
        )
        void parsePlaylistContentForTab(tabId, message.url, message.text, message.pageUrl || null)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PrefetchResult":
      ;(async () => {
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
          updatePrefetchOutcome(message.url, true)
          bumpActivity("prefetched", 1)
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
        const outcome = updatePrefetchOutcome(message.url, false, errorText, { transient })
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
    default:
      return false
  }
})
