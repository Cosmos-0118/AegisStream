(() => {
var ns = (self.AegisBackground ||= {})
const {
  state,
  addLog,
  stripHash,
  isPlaylistUrl,
  isLikelyChunkUrl,
  pruneRuntimeState,
  observeChunkFromWebRequest,
  noteTwitchAuthFromUrl,
  noteTabPageUrl,
  isReactivePrefetchTab,
  refreshActivePrefetchTab,
  setActivePrefetchTab,
  syncKnownSegmentsToPage,
  maybeRequestPrefetchForTab,
  isScriptInjectionAllowedUrl,
  isSkippableHeaderHintUrl,
  armHeaderHintsForUrl,
  ensureTabBridgeReady,
  wakeBackgroundEngine,
  handleExtensionInstall,
  handleBrowserStartup,
  setWorkerRestartReason
} = ns

function registerChromeEventListeners() {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      void wakeBackgroundEngine()
      if (details.tabId < 0 || !state.settings.enabled) return
      pruneRuntimeState()
      const url = stripHash(details.url)
      if (!url) return
      noteTwitchAuthFromUrl(details.tabId, url)
      if (isPlaylistUrl(url)) {
        if (!isReactivePrefetchTab(details.tabId)) {
          addLog("INFO", `Playlist request detected via webRequest: ${url.slice(-80)}`)
        }
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
          if (!isReactivePrefetchTab(details.tabId)) {
            addLog("INFO", `Playlist detected via content-type (${ct}): ${url.slice(-80)}`)
          }
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
    if (typeof ns.clearEpisodeTransitionTelemetry === "function") {
      ns.clearEpisodeTransitionTelemetry(tabId)
    }
    state.bridgeHeartbeatByTab.delete(tabId)
    state.tabPageHostByTab?.delete(tabId)
    state.tabPageUrlFingerprintByTab?.delete(tabId)
    state.twitchSessionByTab?.delete(tabId)
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

  chrome.runtime.onInstalled.addListener((details) => {
    const reason = details?.reason === "install" ? "install" : "update"
    if (typeof setWorkerRestartReason === "function") {
      setWorkerRestartReason(reason)
    }
    addLog("INFO", "Extension installed/updated")
    void handleExtensionInstall()
  })

  chrome.runtime.onStartup.addListener(() => {
    if (typeof setWorkerRestartReason === "function") {
      setWorkerRestartReason("browser_startup")
    }
    addLog("INFO", "Browser started — loading settings")
    void handleBrowserStartup()
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (!state.settings.enabled || state.settings.headerEarlyHints === false) return
    if (changeInfo.status !== "loading" || !isScriptInjectionAllowedUrl(tab?.url)) return
    if (isSkippableHeaderHintUrl(tab.url)) return
    try {
      const pathname = new URL(tab.url).pathname || ""
      if (/^\/watch\//i.test(pathname)) return
    } catch {
      // ignore
    }
    void armHeaderHintsForUrl(tab.url, "tab-loading").catch(() => {})
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
      if (typeof ns.syncCacheRegistryToTab === "function") {
        void ns.syncCacheRegistryToTab(tabId)
      }
      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "tab-activated")
      }
    })
  })

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) {
      noteTabPageUrl(tabId, changeInfo.url)
      state.bridgeHeartbeatByTab.delete(tabId)
    }
    if (changeInfo.status !== "complete") return
    if (!isScriptInjectionAllowedUrl(tab?.url)) return

    void ensureTabBridgeReady(tabId, "tab-updated", false).then((ready) => {
      if (!ready) return
      const tabState = state.playlistByTab.get(tabId)
      if (!tabState?.segments?.length) return
      syncKnownSegmentsToPage(tabId, tabState.segments, { reason: "tab-updated" })
      if (typeof ns.syncCacheRegistryToTab === "function") {
        void ns.syncCacheRegistryToTab(tabId)
      }
      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "tab-updated")
      }
    })
  })
}

ns.registerChromeEventListeners = registerChromeEventListeners
})()
