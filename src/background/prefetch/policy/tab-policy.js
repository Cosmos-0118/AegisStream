(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

function releaseInflightForTab(tabId, options = {}) {
  for (const [url, inflight] of state.inflightPrefetches.entries()) {
    if (inflight?.tabId !== tabId) continue
    if (typeof ns.tryReleaseInflightEntry === "function") {
      ns.tryReleaseInflightEntry(url, { logPreserve: options.logPreserveConsumers !== false })
    } else {
      state.inflightPrefetches.delete(url)
    }
  }
  const tabState = state.playlistByTab.get(tabId)
  if (tabState?.activeInflightSegmentIndices instanceof Set) {
    tabState.activeInflightSegmentIndices.clear()
  }
  if (options.notifyPage === false) return
  if (tabState && typeof ns.broadcastDelegatedPrefetchAbort === "function") {
    ns.broadcastDelegatedPrefetchAbort(tabId, tabState, {
      reason: options.reason || "release-inflight",
      log: false
    })
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

function isTabVisibilitySleeping(tabState) {
  return tabState?.visibilitySleepActive === true
}

function pauseTabPrefetchForVisibility(tabId, reason = "tab-hidden") {
  if (!Number.isFinite(tabId)) return
  let tabState = state.playlistByTab.get(tabId)
  if (!tabState) {
    tabState = { segments: [], updatedAt: Date.now() }
    state.playlistByTab.set(tabId, tabState)
  }
  if (tabState.visibilitySleepActive === true) return
  tabState.visibilitySleepActive = true
  tabState.visibilitySleepAt = Date.now()
  tabState.speculativeAllowed = false
  cancelPendingPrefetchForTab(tabId)
  if (tabState.prefetchCapRetryTimer) {
    clearTimeout(tabState.prefetchCapRetryTimer)
    tabState.prefetchCapRetryTimer = null
  }
  tabState.prefetchCapRetryPending = null
  if (tabState.prefetchInflightRetryTimer) {
    clearTimeout(tabState.prefetchInflightRetryTimer)
    tabState.prefetchInflightRetryTimer = null
  }
  tabState.prefetchInflightRetryPending = null
  addLog("INFO", `Tab ${tabId} hidden — prefetch engine sleeping (${reason})`)
  if (typeof ns.recordDecision === "function") {
    ns.recordDecision("visibility", "pause", reason || "tab-hidden")
  }
}

function resumeTabPrefetchForVisibility(tabId, reason = "tab-visible") {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.visibilitySleepActive) return
  tabState.visibilitySleepActive = false
  tabState.visibilitySleepAt = 0
  setActivePrefetchTab(tabId, reason || "visibility-resume")
  addLog("INFO", `Tab ${tabId} visible — prefetch engine resuming (${reason})`)
  if (typeof ns.recordDecision === "function") {
    ns.recordDecision("visibility", "resume", reason || "tab-visible")
  }
  if (
    tabState.hasAnchor &&
    typeof tabState.anchorIndex === "number" &&
    Array.isArray(tabState.segments) &&
    tabState.segments.length &&
    typeof ns.maybeRequestPrefetchForTab === "function"
  ) {
    const start = Math.max(0, tabState.anchorIndex)
    ns.maybeRequestPrefetchForTab(tabId, tabState.segments, start, "visibility-resume", {
      force: true,
      prefetchWindowOverride: Math.max(
        Number(constants.VARIANT_SWITCH_PREFETCH_WINDOW) || 12,
        Number(state.settings.prefetchWindow) || 8
      )
    })
  }
}

function isTabEligibleForPrefetch(tabId) {
  if (!state.settings.enabled || !state.settings.prefetchEnabled) return false
  if (!Number.isFinite(tabId) || tabId < 0) return false
  const tabState = state.playlistByTab.get(tabId)
  if (isTabVisibilitySleeping(tabState)) return false
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
  const teleportThreshold = Number(constants.TELEPORT_MODE_JUMP_THRESHOLD) || 20
  if (Math.abs(nextIndex - previousIndex) >= teleportThreshold) {
    return
  }
  tabState.prefetchCooldownUntil = Math.min(
    Number(tabState.prefetchCooldownUntil || 0) || now + constants.PREFETCH_ANCHOR_COOLDOWN_MS,
    now + Math.floor(constants.PREFETCH_ANCHOR_COOLDOWN_MS / 2)
  )
}

function cancelAllPendingPrefetches() {
  for (const tabId of state.pendingPrefetchByTab.keys()) {
    cancelPendingPrefetchForTab(tabId)
  }
}

async function broadcastSettingsToTabs(settings) {
  const payload =
    typeof ns.buildSettingsPayloadForTabs === "function"
      ? ns.buildSettingsPayloadForTabs()
      : settings || state.settings
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
ns.isTabVisibilitySleeping = isTabVisibilitySleeping
ns.pauseTabPrefetchForVisibility = pauseTabPrefetchForVisibility
ns.resumeTabPrefetchForVisibility = resumeTabPrefetchForVisibility
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
