(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

// ─── Cap retry helpers ───

ns.clearPrefetchCapRetry = function clearPrefetchCapRetry(tabState) {
  if (!tabState) return
  if (tabState.prefetchCapRetryTimer) { clearTimeout(tabState.prefetchCapRetryTimer); tabState.prefetchCapRetryTimer = null }
  tabState.prefetchCapRetryPending = null; tabState.prefetchCapRetryAttempts = 0; tabState.prefetchCapRetryDelayMs = 0
}

ns.clearPrefetchInflightRetry = function clearPrefetchInflightRetry(tabState) {
  if (!tabState) return
  if (tabState.prefetchInflightRetryTimer) { clearTimeout(tabState.prefetchInflightRetryTimer); tabState.prefetchInflightRetryTimer = null }
  tabState.prefetchInflightRetryPending = null
}

ns.isPrefetchWorkStale = function isPrefetchWorkStale(tabState, pending) {
  if (!pending) return true
  if (tabState && typeof pending.scheduleGeneration === "number" && pending.scheduleGeneration !== Number(tabState.networkGeneration || 0)) return true
  const queuedAt = Number(pending.queuedAt || 0)
  if (queuedAt > 0 && Date.now() - queuedAt > constants.PREFETCH_QUEUE_MAX_AGE_MS) return true
  if (tabState?.hasAnchor && typeof tabState.anchorIndex === "number" && typeof pending.startIndex === "number") {
    const drift = tabState.anchorIndex - pending.startIndex
    if (drift > Math.max(Number(state.settings?.prefetchWindow || 8) * 2, 8)) return true
  }
  return false
}

ns.dropStalePrefetchWork = function dropStalePrefetchWork(tabId, tabState, pending, reason) {
  ns.clearPrefetchCapRetry(tabState); ns.clearPrefetchInflightRetry(tabState)
  const ageSec = pending?.queuedAt > 0 ? Math.round((Date.now() - pending.queuedAt) / 1000) : null
  addLog("INFO", `Dropped stale prefetch work on tab ${tabId} (${reason}${ageSec !== null ? `, age=${ageSec}s` : ""})`)
}

// ─── Window and duplicate resolution ───

ns.resolveEffectivePrefetchWindow = function resolveEffectivePrefetchWindow(tabId) {
  if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) return 0
  const baseWindow = Math.max(1, Number(state.settings.prefetchWindow) || 1)
  const jumps = typeof ns.getAnchorJumpCount === "function" ? ns.getAnchorJumpCount(tabId) : 0
  let windowSize = baseWindow
  const tabState = state.playlistByTab.get(tabId)
  const recentVariantSwitch = Date.now() - Number(tabState?.lastQualityVariantSwitchAt || 0) < 5000

  if (tabState && ns.isTabInVariantSwitchGrace(tabState)) windowSize = Math.max(windowSize, Number(constants.VARIANT_SWITCH_PREFETCH_WINDOW) || 12)
  else if (tabState && ns.isTabInSeekChurnAggressive(tabState)) windowSize = Math.max(windowSize, Number(constants.SEEK_CHURN_PREFETCH_WINDOW_MIN) || 10)
  else if (jumps >= constants.PREFETCH_TAB_BURST_THRESHOLD && !recentVariantSwitch) windowSize = Math.max(baseWindow, constants.PREFETCH_BURST_WINDOW_CAP)

  const runwaySec = Number(tabState?.bufferRunwaySec || tabState?.runwaySec || 0)
  if (Number.isFinite(runwaySec) && runwaySec > 0) {
    if (runwaySec <= Number(constants.BUFFER_RUNWAY_EMERGENCY_SEC) || runwaySec <= Number(constants.SEEK_PASSENGER_STALL_RUNWAY_SEC) + 1) {
      windowSize = Math.max(windowSize, Math.min(baseWindow + 4, Number(constants.PREFETCH_BURST_WINDOW_CAP) || 8))
    } else if (runwaySec <= Number(constants.BUFFER_RUNWAY_AGGRESSIVE_SEC)) {
      windowSize = Math.max(windowSize, Math.min(baseWindow + 2, Number(constants.PREFETCH_BURST_WINDOW_CAP) || 8))
    }
  }

  if (typeof ns.isInRefreshRecovery === "function" && ns.isInRefreshRecovery(tabState)) windowSize = Math.min(windowSize, constants.REFRESH_RECOVERY_MAX_CHUNKS)
  if (typeof ns.resolveBufferAdjustedPrefetchWindow === "function") windowSize = ns.resolveBufferAdjustedPrefetchWindow(tabId, windowSize)
  if (typeof ns.applyCongestionPrefetchRadius === "function") windowSize = ns.applyCongestionPrefetchRadius(tabId, windowSize)
  return windowSize
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

function schedulePrefetchInflightRetry(tabId, tabState, segments, startIndex, source = "schedule") {
  if (!tabState) return
  const pendingSnapshot = { segments, startIndex, source, queuedAt: Date.now(), scheduleGeneration: Number(tabState.networkGeneration) || 0 }
  tabState.prefetchInflightRetryPending = pendingSnapshot
  if (tabState.prefetchInflightRetryTimer) clearTimeout(tabState.prefetchInflightRetryTimer)
  tabState.prefetchInflightRetryTimer = setTimeout(() => {
    tabState.prefetchInflightRetryTimer = null
    const pending = tabState.prefetchInflightRetryPending
    if (!pending) return
    tabState.prefetchInflightRetryPending = null
    if (ns.isPrefetchWorkStale(tabState, pending)) { ns.dropStalePrefetchWork(tabId, tabState, pending, "inflight-retry-stale"); return }
    void ns.schedulePrefetch(tabId, pending.segments, pending.startIndex, { source: pending.source, force: true, inflightRetry: true })
  }, constants.PREFETCH_INFLIGHT_RETRY_MS)
}

function schedulePrefetchCapRetry(tabId, tabState, segments, startIndex, source) {
  if (!tabState) return
  const existing = tabState.prefetchCapRetryPending
  const queuedAt = existing?.queuedAt || Date.now()
  const pendingSnapshot = { segments, startIndex, source, queuedAt, scheduleGeneration: Number(tabState.networkGeneration) || 0 }
  if (ns.isPrefetchWorkStale(tabState, pendingSnapshot)) { ns.dropStalePrefetchWork(tabId, tabState, pendingSnapshot, "queue-age"); return }
  const attempts = Number(tabState.prefetchCapRetryAttempts || 0) + 1
  if (attempts > constants.PREFETCH_CAP_RETRY_MAX_ATTEMPTS) { ns.clearPrefetchCapRetry(tabState); addLog("WARN", `Prefetch cap retry exhausted on tab ${tabId} after ${constants.PREFETCH_CAP_RETRY_MAX_ATTEMPTS} attempts`); return }
  const delayMs = ns.computeCapRetryDelayMs(attempts)
  tabState.prefetchCapRetryAttempts = attempts; tabState.prefetchCapRetryDelayMs = delayMs; tabState.prefetchCapRetryPending = pendingSnapshot
  if (tabState.prefetchCapRetryTimer) clearTimeout(tabState.prefetchCapRetryTimer)
  tabState.prefetchCapRetryTimer = setTimeout(() => {
    tabState.prefetchCapRetryTimer = null
    const pending = tabState.prefetchCapRetryPending
    if (!pending) return
    if (ns.isPrefetchWorkStale(tabState, pending)) { ns.dropStalePrefetchWork(tabId, tabState, pending, "queue-age"); return }
    tabState.prefetchCapRetryPending = null
    void ns.schedulePrefetch(tabId, pending.segments, pending.startIndex, { source: pending.source, force: true, capRetry: true })
  }, delayMs)
}

// ─── schedulePrefetch (core) ───

ns.schedulePrefetch = async function schedulePrefetch(tabId, segments, startIndex = 0, options = {}) {
  if (!state.settings.enabled || !state.settings.prefetchEnabled) return
  if (typeof ns.isTabEligibleForPrefetch === "function" && !ns.isTabEligibleForPrefetch(tabId)) return
  if (
    typeof ns.isTabInTransitionWarmup === "function" &&
    ns.isTabInTransitionWarmup(tabId) &&
    !/quality-switch-warm|playlist-url-rotation|warm-recovery|next-episode|bridge-ready/i.test(String(options.source || ""))
  ) return
  if (typeof ns.isTabInWarmRecoveryDeferPrefetch === "function" && ns.isTabInWarmRecoveryDeferPrefetch()) return

  const normalized = typeof ns.normalizeSegments === "function" ? ns.normalizeSegments(segments) : segments
  if (!normalized.length) return

  const tabState = typeof ns.upsertPlaylistState === "function" ? ns.upsertPlaylistState(tabId, normalized) : state.playlistByTab.get(tabId)
  if (!tabState) return
  if (ns.isPrefetchBlocked(tabState)) return

  // Engine arbitration
  const engineMode = typeof ns.arbitrateTabStreaming === "function" ? ns.arbitrateTabStreaming(tabState) : typeof ns.evaluateStreamingUrgency === "function" ? ns.evaluateStreamingUrgency(tabState) : null
  if (engineMode === ns.EngineModes?.RESCUE && typeof ns.executeRescuePrefetch === "function") { await ns.executeRescuePrefetch(tabId, tabState, normalized, options); return }
  if (typeof ns.arbitratePrefetchSchedule === "function") { const decision = ns.arbitratePrefetchSchedule(tabId, tabState, options.source || "schedule", options); if (!decision.allow) return }
  if (typeof ns.isTabInAnchorCooldown === "function" && ns.isTabInAnchorCooldown(tabState)) return

  const force = Boolean(options.force)
  const now = Date.now()
  const clampedStartIndex = Math.max(0, Math.min(startIndex, normalized.length))
  if (typeof ns.computeCongestionDirectivesForTab === "function") ns.computeCongestionDirectivesForTab(tabId)
  const runwaySec = Number(tabState?.bufferRunwaySec || tabState?.runwaySec || 0)
  const windowPressure = Number.isFinite(runwaySec) && runwaySec > 0 ? Math.max(0, (Number(constants.BUFFER_RUNWAY_NORMAL_SEC) || 30) - runwaySec) : 0
  if (shouldSkipDuplicateSchedule(tabState, clampedStartIndex, now, force)) return

  let effectiveWindow = ns.resolveEffectivePrefetchWindow(tabId)
  if (windowPressure > 0) {
    effectiveWindow = Math.max(
      effectiveWindow,
      Math.min(
        normalized.length,
        Math.round(effectiveWindow + Math.min(windowPressure / 6, Number(constants.PREFETCH_BURST_WINDOW_CAP) || 8))
      )
    )
  }
  const windowOverride = Number(options.prefetchWindowOverride)
  if (Number.isFinite(windowOverride) && windowOverride > 0) effectiveWindow = Math.max(effectiveWindow, Math.min(windowOverride, normalized.length))
  if (effectiveWindow === 0) { tabState.lastScheduledFromIndex = clampedStartIndex; tabState.lastScheduledAt = now; tabState.updatedAt = now; return }

  // Churn logging — only log state transitions, not every schedule call
  if (ns.isTabInSeekChurnAggressive(tabState)) {
    if (tabState.highChurnMode !== true) {
      tabState.highChurnMode = true
      addLog("INFO", `Seek churn aggressive on tab ${tabId}; prefetch window ${effectiveWindow} (guard ring expanded)`)
    }
  } else if (tabState.highChurnMode === true) {
    tabState.highChurnMode = false
    addLog("INFO", `Seek churn normalized on tab ${tabId}; restoring prefetch window to ${state.settings.prefetchWindow}`)
  }

  let targets = normalized.slice(clampedStartIndex, clampedStartIndex + effectiveWindow)
  if (!targets.length) return
  if (typeof ns.reorderTargetsByByteCost === "function") targets = ns.reorderTargetsByByteCost(targets, tabState)
  if (typeof ns.reorderTargetsForPriorityLane === "function") targets = ns.reorderTargetsForPriorityLane(targets, tabState)

  const source = options.source || "schedule"
  const prefetchLane = typeof ns.classifyPrefetchLane === "function" ? ns.classifyPrefetchLane(source) : "maintenance"
  const globalCap = typeof ns.resolveCongestionGlobalCap === "function" ? ns.resolveCongestionGlobalCap(tabId) : (typeof ns.resolveBufferAdjustedGlobalCap === "function" ? ns.resolveBufferAdjustedGlobalCap(tabId) : Infinity)
  const globalInflight = typeof ns.countGlobalInflightPrefetches === "function" ? ns.countGlobalInflightPrefetches() : 0

  const uncached = []; let blockedInflight = 0, blockedCooldown = 0, blockedLane = 0

  for (const url of targets) {
    if (ns.segmentIndexHasActivePrefetch(tabId, tabState, normalized.indexOf(url))) { blockedInflight += 1; continue }
    const normalizedUrl = ns.normalizePrefetchUrl(url)
    if (!normalizedUrl) { blockedCooldown += 1; continue }
    const failureInfo = state.failedPrefetches.get(normalizedUrl)
    if (failureInfo) {
      const retryAfter = typeof failureInfo === "number" ? failureInfo : Number(failureInfo?.retryAfter || 0)
      if (Date.now() < retryAfter) { blockedCooldown += 1; continue }
    }
    if (prefetchLane === "speculative" && typeof ns.isSpeculativeLaneAvailable === "function" && !ns.isSpeculativeLaneAvailable(tabId)) { blockedLane += 1; continue }
    uncached.push(url)
  }

  ns.clearPrefetchCapRetry(tabState)
  const availableSlots = globalCap - globalInflight
  const batchInflightCap = Math.max(1, Number(constants.PREFETCH_BATCH_INFLIGHT_CAP) || 8)
  const batch = uncached.slice(0, Math.min(availableSlots, batchInflightCap))

  if (!batch.length) {
    const shouldLogSkip = now - tabState.lastSkipLogAt > constants.PREFETCH_LOG_THROTTLE_MS
    if ((blockedInflight > 0 || blockedCooldown > 0 || blockedLane > 0) && shouldLogSkip) {
      addLog("INFO", `Prefetch paused on tab ${tabId}: inflight=${blockedInflight}, retryCooldown=${blockedCooldown}, laneBlocked=${blockedLane}`)
      if (blockedLane > 0 && typeof ns.notePainLaneBlocked === "function") ns.notePainLaneBlocked(prefetchLane, blockedLane)
      tabState.lastSkipLogAt = now
    } else if (blockedInflight === 0 && blockedCooldown === 0 && shouldLogSkip) { addLog("INFO", `All ${targets.length} target chunks already cached`); tabState.lastSkipLogAt = now }
    if (blockedInflight > 0 && uncached.length > 0 && !options.inflightRetry) schedulePrefetchInflightRetry(tabId, tabState, normalized, clampedStartIndex, options.source || "schedule")
    tabState.lastScheduledFromIndex = clampedStartIndex; tabState.lastScheduledAt = now; tabState.updatedAt = now; return
  }

  ns.clearPrefetchInflightRetry(tabState)

  // Mark inflight
  const inflightAt = Date.now()
  for (const url of batch) {
    const normalizedUrl = ns.normalizePrefetchUrl(url)
    if (!normalizedUrl) continue
    const inflightEntry = { tabId, source, lane: prefetchLane, startedAt: inflightAt, networkGeneration: Number(tabState.networkGeneration) || 0, consumers: 0, abortLocked: false, pendingRelease: false }
    if (typeof ns.attachInflightCategory === "function") ns.attachInflightCategory(inflightEntry)
    else inflightEntry.category = source.includes("rescue") ? "rescue" : source.includes("speculative") ? "speculative" : "prefetch"
    state.inflightPrefetches.set(normalizedUrl, inflightEntry)
    if (typeof inflightEntry.segmentIndex !== "number" && tabState?.segments?.length) {
      const urlIndex = tabState.segments.findIndex((s) => ns.normalizePrefetchUrl(s) === normalizedUrl)
      if (urlIndex >= 0) inflightEntry.segmentIndex = urlIndex
    }
    if (typeof inflightEntry.segmentIndex === "number") ns.noteInflightSegmentIndices(tabState, inflightEntry.segmentIndex, 1)
  }

  const scheduleSource = options.source || "schedule"
  addLog("INFO", `Scheduling prefetch of ${batch.length} chunks for tab ${tabId} (from index ${clampedStartIndex}, source=${scheduleSource}, mode=${engineMode || "NORMAL"})`)
  tabState.lastScheduledFromIndex = clampedStartIndex; tabState.lastScheduledAt = now; tabState.updatedAt = now

  const delegated = await ns.delegatePrefetchToPage(tabId, batch, { source: scheduleSource, priority: options.priority || (/buffer-load-push|rescue|buffer-emergency|scrub-snap-back/.test(scheduleSource) ? "high" : "low") })
  if (!delegated) { for (const url of batch) ns.updatePrefetchOutcome(url, false, "delegate-failed"); return }
  if (uncached.length > batch.length) schedulePrefetchCapRetry(tabId, tabState, normalized, clampedStartIndex, options.source || "schedule")
  if (typeof ns.maybeScheduleSpeculativePrefetch === "function" && engineMode !== ns.EngineModes?.RESCUE && !(typeof ns.isRescueModeActive === "function" && ns.isRescueModeActive(tabState))) ns.maybeScheduleSpeculativePrefetch(tabId)
}

// ─── maybeRequestPrefetchForTab ───

ns.maybeRequestPrefetchForTab = function maybeRequestPrefetchForTab(tabId, segments, startIndex, source, options = {}) {
  if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) { addLog("DEBUG", `Reactive media mode: forward prefetch disabled (${source}, tab ${tabId})`); return }
  const tabState = state.playlistByTab.get(tabId)
  if (ns.isPrefetchBlocked(tabState)) return
  const transitionSource = /quality-switch-warm|bridge-ready|playlist-url-rotation|warm-recovery|next-episode/i.test(String(source || ""))
  if (
    !transitionSource &&
    typeof ns.isTabInWarmRecoveryDeferPrefetch === "function" &&
    ns.isTabInWarmRecoveryDeferPrefetch()
  ) return
  if (source === "chunk-observed" && ns.segmentIndexHasActivePrefetch(tabId, tabState, startIndex)) return
  if (!options.force) {
    if (ns.isTabInRapidSeek(tabState) && !ns.isTabInSeekChurnAggressive(tabState)) return
    if (typeof ns.isTabInAnchorCooldown === "function" && ns.isTabInAnchorCooldown(tabState) && !ns.isTabInTeleportMode(tabState)) return
  }
  ns.requestPrefetchForTab(tabId, segments, startIndex, source, options)
}

// ─── requestPrefetchForTab ───

ns.requestPrefetchForTab = function requestPrefetchForTab(tabId, segments, startIndex = 0, source = "anchor", options = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return
  if (typeof ns.isTabEligibleForPrefetch === "function" && !ns.isTabEligibleForPrefetch(tabId)) return

  const tabState = state.playlistByTab.get(tabId)
  if (ns.isPrefetchBlocked(tabState)) return
  if (typeof ns.arbitratePrefetchSchedule === "function") { const decision = ns.arbitratePrefetchSchedule(tabId, tabState, source, options); if (!decision.allow) return }

  const tier = typeof ns.getTabBufferTier === "function" ? ns.getTabBufferTier(tabId) : null
  const panicActive = typeof ns.isNetworkPanicActive === "function" && ns.isNetworkPanicActive()
  const now = Date.now()
  const minGap = options.force ? 0 : panicActive || tier === ns.TIER_EMERGENCY ? constants.PREFETCH_EMERGENCY_MIN_GAP_MS : tier === ns.TIER_AGGRESSIVE ? 250 : 0
  if (minGap > 0 && tabState?.lastPrefetchRequestAt && now - tabState.lastPrefetchRequestAt < minGap) return
  if (tabState) tabState.lastPrefetchRequestAt = now

  const existing = state.pendingPrefetchByTab.get(tabId)
  if (existing?.timerId) {
    const existingPri = typeof ns.prefetchSourcePriority === "function" ? ns.prefetchSourcePriority(existing.source) : 0
    const newPri = typeof ns.prefetchSourcePriority === "function" ? ns.prefetchSourcePriority(source) : 0
    if (newPri < existingPri) return
    clearTimeout(existing.timerId)
  }

  const queuedAt = existing?.queuedAt || Date.now()
  const clampedStartIndex = Math.max(0, Number(startIndex) || 0)
  const scheduleGeneration = Number(tabState?.networkGeneration) || 0
  const pendingSnapshot = { segments, startIndex: clampedStartIndex, source, queuedAt, options, scheduleGeneration }

  if (ns.isPrefetchWorkStale(tabState, pendingSnapshot)) { ns.dropStalePrefetchWork(tabId, tabState, pendingSnapshot, "debounce-queue"); return }

  const timerId = setTimeout(() => {
    const pending = state.pendingPrefetchByTab.get(tabId)
    if (!pending) return
    state.pendingPrefetchByTab.delete(tabId)
    const currentTabState = state.playlistByTab.get(tabId)
    if (ns.isPrefetchWorkStale(currentTabState, pending)) { ns.dropStalePrefetchWork(tabId, currentTabState, pending, "debounce-queue"); return }
    void ns.schedulePrefetch(tabId, pending.segments, pending.startIndex, { source: pending.source, ...(pending.options || {}) })
  }, constants.PREFETCH_BATCH_DEBOUNCE_MS)

  state.pendingPrefetchByTab.set(tabId, { timerId, source, startIndex: clampedStartIndex, segments, queuedAt, options, scheduleGeneration })
}
})()
