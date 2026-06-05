(() => {
var ns = (self.AegisBackground ||= {})
const {
  constants,
  state,
  addLog,
  isScriptInjectionAllowedUrl,
  isRestrictedInjectionError,
  syncKnownSegmentsToPage,
  maybeRequestPrefetchForTab,
  noteTabPageUrl,
  isTabEligibleForPrefetch,
  installDocumentStreamHook,
  loadSettings,
  syncPerformanceGemsFromSettings,
  computeAdaptiveCachePolicy,
  refreshActivePrefetchTab
} = ns

let engineInFlight = null
let engineReady = false
let bootstrapInFlight = null
let lastBootstrapAt = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function pingTabBridgeOnce(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "AegisStream:Ping" })
    return Boolean(response?.ok)
  } catch {
    return false
  }
}

async function pingTabBridge(tabId) {
  const retries = constants.TAB_BRIDGE_PING_RETRIES
  const delayMs = constants.TAB_BRIDGE_PING_RETRY_MS
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (await pingTabBridgeOnce(tabId)) return true
    if (attempt < retries - 1) await sleep(delayMs)
  }
  return false
}

async function injectTabBridgeScripts(tabId, tabUrl) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ns.ISOLATED_CONTENT_FILES,
    world: "ISOLATED"
  })
  if (isYouTubeUrl(tabUrl)) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ns.YOUTUBE_MAIN_PAGE_FILES,
      world: "MAIN"
    })
  }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ns.MAIN_PAGE_SCRIPT_FILES,
    world: "MAIN"
  })
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
  if (!isScriptInjectionAllowedUrl(tab?.url)) return false
  if (tab?.url) noteTabPageUrl(tabId, tab.url)

  if (await pingTabBridge(tabId)) {
    state.bridgeHeartbeatByTab.set(tabId, now)
    return true
  }

  try {
    await injectTabBridgeScripts(tabId, tab.url)
    state.bridgeHeartbeatByTab.set(tabId, Date.now())
    addLog("INFO", `Reinjected content bridge into tab ${tabId} (${reason})`)

    const tabState = state.playlistByTab.get(tabId)
    if (tabState?.segments?.length) {
      syncKnownSegmentsToPage(tabId, tabState.segments, { reason: `reinject:${reason}` })
      if (typeof ns.syncCacheRegistryToTab === "function") {
        void ns.syncCacheRegistryToTab(tabId)
      }
      if (
        isTabEligibleForPrefetch(tabId) &&
        tabState.hasAnchor &&
        typeof tabState.anchorIndex === "number"
      ) {
        maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, `resume:${reason}`)
      }
    }
    return true
  } catch (e) {
    if (isRestrictedInjectionError(e.message)) {
      addLog("DEBUG", `Bridge injection unavailable for tab ${tabId} (${reason})`)
    } else {
      addLog("WARN", `Bridge reinjection skipped for tab ${tabId} (${reason}): ${e.message}`)
    }
    return false
  }
}

async function resolveBootstrapTargetTab() {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return null
  }

  const injectable = tabs.filter((tab) => isScriptInjectionAllowedUrl(tab.url))
  if (!injectable.length) return null

  let target = injectable.find((tab) => tab.active)
  if (!target) {
    try {
      const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (focused?.id && isScriptInjectionAllowedUrl(focused.url)) {
        target = focused
      }
    } catch {
      // ignore
    }
  }
  return target || injectable[0]
}

/** State, hooks, and cache policy only — never injects page scripts. */
async function runBackgroundEngine() {
  await loadSettings()
  installDocumentStreamHook()
  await syncPerformanceGemsFromSettings().catch(() => {})
  await computeAdaptiveCachePolicy(true).catch(() => {})
  await refreshActivePrefetchTab()
}

async function ensureBackgroundEngineReady() {
  if (engineReady) return
  if (engineInFlight) return engineInFlight
  engineInFlight = runBackgroundEngine()
    .then(async () => {
      engineReady = true
      if (typeof ns.loadWarmRecoverySnapshot === "function") {
        try {
          const snapshot = await ns.loadWarmRecoverySnapshot()
          if (snapshot) {
            ns.applyWarmRecoverySnapshot(snapshot)
          }
        } catch {
          // Non-critical – we'll rebuild state from live traffic
        }
      }
      if (typeof ns.rebuildCacheRegistryFromDb === "function") {
        void ns.rebuildCacheRegistryFromDb()
      }
    })
    .finally(() => {
      engineInFlight = null
    })
  return engineInFlight
}

/** SW wake (message / webRequest): restore in-memory engine state, no tab injection. */
async function wakeBackgroundEngine() {
  return ensureBackgroundEngineReady()
}

async function refreshTabBridgesAfterUpdate() {
  try {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!tab?.id || tab.id < 0 || !isScriptInjectionAllowedUrl(tab?.url)) continue
      // Ping-first without force — avoids reinjecting page scripts into tabs that are mid-playback.
      void ensureTabBridgeReady(tab.id, "extension-update", false)
    }
  } catch {
    // ignore
  }
}

/** Extension install/update or explicit reload: engine + active tab only. */
async function handleExtensionInstall() {
  engineReady = false
  engineInFlight = null
  await ensureBackgroundEngineReady()

  await bootstrapActiveTabOnly(true)
  const rebuildMs = Number(constants.WARM_RECOVERY_STATE_REBUILD_MS) || 5_000
  setTimeout(() => {
    void refreshTabBridgesAfterUpdate()
  }, rebuildMs)
}

/** Browser cold start: engine only; manifest content_scripts own tab injection. */
async function handleBrowserStartup() {
  engineReady = false
  engineInFlight = null
  return ensureBackgroundEngineReady()
}

async function bootstrapActiveTabOnly(force = false) {
  const now = Date.now()
  if (!force && now - lastBootstrapAt < constants.BACKGROUND_INIT_DEBOUNCE_MS) {
    return
  }
  if (bootstrapInFlight) return bootstrapInFlight

  bootstrapInFlight = (async () => {
    const target = await resolveBootstrapTargetTab()
    if (!target?.id) return
    const reason = force ? "installed" : "bootstrap"
    await ensureTabBridgeReady(target.id, reason, force)
  })().finally(() => {
    bootstrapInFlight = null
    lastBootstrapAt = Date.now()
  })
  return bootstrapInFlight
}

ns.ensureTabBridgeReady = ensureTabBridgeReady
ns.ensureBackgroundEngineReady = ensureBackgroundEngineReady
ns.wakeBackgroundEngine = wakeBackgroundEngine
ns.bootstrapActiveTabOnly = bootstrapActiveTabOnly
ns.handleExtensionInstall = handleExtensionInstall
ns.handleBrowserStartup = handleBrowserStartup
})()
