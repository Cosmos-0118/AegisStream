(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

function releaseInflightForTab(tabId) {
  for (const [url, inflight] of state.inflightPrefetches.entries()) {
    if (inflight?.tabId === tabId) {
      state.inflightPrefetches.delete(url)
    }
  }
}

function cancelPendingPrefetchForTab(tabId) {
  const pending = state.pendingPrefetchByTab.get(tabId)
  if (pending?.timerId) clearTimeout(pending.timerId)
  state.pendingPrefetchByTab.delete(tabId)
}

function cancelPrefetchForInactiveTabs(keepTabId) {
  for (const tabId of state.pendingPrefetchByTab.keys()) {
    if (tabId !== keepTabId) cancelPendingPrefetchForTab(tabId)
  }
  for (const [url, inflight] of state.inflightPrefetches.entries()) {
    if (inflight?.tabId !== keepTabId) {
      state.inflightPrefetches.delete(url)
    }
  }
}

async function refreshActivePrefetchTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.id && tab.id >= 0) {
      setActivePrefetchTab(tab.id, "query")
    }
  } catch {
    // ignore
  }
}

function setActivePrefetchTab(tabId, reason = "unknown") {
  if (!Number.isFinite(tabId) || tabId < 0) return
  const previous = state.activePrefetchTabId
  if (previous === tabId) return
  state.activePrefetchTabId = tabId
  cancelPrefetchForInactiveTabs(tabId)
  if (previous != null && previous !== tabId) {
    addLog("INFO", `Prefetch focus moved to tab ${tabId} (${reason}); paused background tabs`)
  }
}

function isTabEligibleForPrefetch(tabId) {
  if (!state.settings.enabled || !state.settings.prefetchEnabled) return false
  if (!Number.isFinite(tabId) || tabId < 0) return false
  return state.activePrefetchTabId === tabId
}

function isTabInAnchorCooldown(tabState) {
  if (!tabState) return false
  const until = Number(tabState.prefetchCooldownUntil || 0)
  return Date.now() < until
}

function applyAnchorJumpCooldown(tabState, previousIndex, nextIndex) {
  if (!tabState) return
  if (typeof previousIndex !== "number" || typeof nextIndex !== "number") return
  const threshold = Math.max(state.settings.prefetchWindow * 2, 8)
  if (Math.abs(nextIndex - previousIndex) < threshold) return
  const now = Date.now()
  tabState.prefetchCooldownUntil = now + constants.PREFETCH_ANCHOR_COOLDOWN_MS
  tabState.rapidSeekUntil = Math.max(
    Number(tabState.rapidSeekUntil || 0),
    now + constants.RAPID_SEEK_PAUSE_MS
  )
}

function cancelAllPendingPrefetches() {
  for (const tabId of state.pendingPrefetchByTab.keys()) {
    cancelPendingPrefetchForTab(tabId)
  }
}

async function broadcastSettingsToTabs(settings) {
  const payload = settings || state.settings
  if (!payload) return
  try {
    const tabs = await chrome.tabs.query({})
    for (const tab of tabs) {
      if (!tab?.id || tab.id < 0) continue
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "AegisStream:SettingsUpdated",
          settings: payload
        })
      } catch {
        // Tab may not have a content script yet
      }
    }
  } catch {
    // ignore
  }
}

async function stopExtensionActivityOnTabs(settings, reason = "disabled") {
  cancelAllPendingPrefetches()
  state.inflightPrefetches.clear()
  await broadcastSettingsToTabs(settings)
  if (reason !== "silent") {
    addLog("INFO", `Extension activity stopped on open tabs (${reason})`)
  }
}

function countGlobalInflightPrefetches() {
  return state.inflightPrefetches.size
}

function countInflightPrefetchesForTab(tabId) {
  if (!Number.isFinite(tabId)) return 0
  let count = 0
  for (const inflight of state.inflightPrefetches.values()) {
    if (inflight?.tabId === tabId) count += 1
  }
  return count
}

ns.refreshActivePrefetchTab = refreshActivePrefetchTab
ns.setActivePrefetchTab = setActivePrefetchTab
ns.isTabEligibleForPrefetch = isTabEligibleForPrefetch
ns.isTabInAnchorCooldown = isTabInAnchorCooldown
ns.applyAnchorJumpCooldown = applyAnchorJumpCooldown
ns.cancelPendingPrefetchForTab = cancelPendingPrefetchForTab
ns.cancelAllPendingPrefetches = cancelAllPendingPrefetches
ns.broadcastSettingsToTabs = broadcastSettingsToTabs
ns.stopExtensionActivityOnTabs = stopExtensionActivityOnTabs
ns.releaseInflightForTab = releaseInflightForTab
ns.countGlobalInflightPrefetches = countGlobalInflightPrefetches
ns.countInflightPrefetchesForTab = countInflightPrefetchesForTab
})()
