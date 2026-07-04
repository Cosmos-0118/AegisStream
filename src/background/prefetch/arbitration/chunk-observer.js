(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

const chunkObservedDebounceAt = new Map()

function pruneChunkObservedDebounce(now = Date.now()) {
  const cutoff = now - constants.CHUNK_OBSERVED_DEBOUNCE_MS * 4
  for (const [key, ts] of chunkObservedDebounceAt.entries()) { if (ts < cutoff) chunkObservedDebounceAt.delete(key) }
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

ns.pruneRuntimeState = function pruneRuntimeState() {
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
    const retryAfter = typeof failureInfo === "number" ? failureInfo : Number(failureInfo?.retryAfter || 0)
    if (retryAfter + constants.FAILURE_STATE_RETENTION_MS < now) state.failedPrefetches.delete(url)
  }
  for (const [url, inflight] of state.inflightPrefetches.entries()) {
    if (now - Number(inflight?.startedAt || 0) > constants.PREFETCH_INFLIGHT_TTL_MS) {
      if (typeof ns.tryReleaseInflightEntry === "function") ns.tryReleaseInflightEntry(url, { logPreserve: false })
      else state.inflightPrefetches.delete(url)
    }
  }
}

ns.observeChunkFromWebRequest = function observeChunkFromWebRequest(tabId, chunkUrl) {
  if (typeof ns.isTabEligibleForPrefetch === "function" && !ns.isTabEligibleForPrefetch(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (tabState && typeof ns.isUrlTrackedAsPrefetch === "function" && ns.isUrlTrackedAsPrefetch(tabId, tabState, chunkUrl)) return
  void ns.handleChunkObserved(tabId, chunkUrl)
}

ns.handleChunkObserved = async function handleChunkObserved(tabId, chunkUrl, options = {}) {
  const normalizedChunkUrl = typeof ns.stripHash === "function" ? ns.stripHash(chunkUrl) : chunkUrl
  if (!normalizedChunkUrl) return
  if (options.countMetric !== false && shouldCountChunkObserved(tabId, normalizedChunkUrl)) {
    if (typeof ns.bumpActivity === "function") ns.bumpActivity("chunksObserved", 1)
  }

  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length || !tabState.signatureToIndex) return
  tabState.updatedAt = Date.now()

  let chunkIndex = typeof ns.resolveSegmentIndexInManifest === "function" ? ns.resolveSegmentIndexInManifest(normalizedChunkUrl, tabState) : null
  if (typeof chunkIndex !== "number") return
  chunkIndex = typeof ns.remapChunkIndexViaMediaSequence === "function" ? ns.remapChunkIndexViaMediaSequence(tabState, chunkIndex) : chunkIndex

  const hadAnchor = tabState.hasAnchor === true
  const previousAnchorIndex = tabState.anchorIndex
  const wasRetainedAnchor = tabState.anchorRetainedByRefresh === true

  if (hadAnchor && typeof previousAnchorIndex === "number" && typeof ns.shouldRejectAnchorRegression === "function" && ns.shouldRejectAnchorRegression(tabState, previousAnchorIndex, chunkIndex)) {
    addLog("DEBUG", `Ignored spurious anchor regression ${previousAnchorIndex} -> ${chunkIndex} during playlist rotation (tab ${tabId})`); return
  }

  const anchorDecision = typeof ns.evaluateAnchorCommit === "function" ? ns.evaluateAnchorCommit(tabState, chunkIndex, previousAnchorIndex, hadAnchor) : { accept: true, index: chunkIndex }
  if (!anchorDecision.accept) { if (typeof ns.recordAnchorDeferred === "function") ns.recordAnchorDeferred(); return }
  chunkIndex = anchorDecision.index

  tabState.lastPlayerObservedIndex = chunkIndex
  tabState.lastPlayerObservedAt = Date.now()

  const anchorMoved = !hadAnchor || (typeof previousAnchorIndex === "number" && chunkIndex !== previousAnchorIndex)
  if (anchorMoved) {
    if (anchorDecision.via === "monotonic-breakthrough") { if (typeof ns.recordMonotonicBreakthrough === "function") ns.recordMonotonicBreakthrough() }
    else if (typeof ns.recordAnchorCommit === "function") ns.recordAnchorCommit(ns.AnchorAuthority?.NETWORK ?? 1)
    if (!tabState.anchorSource || tabState.anchorSource === "NETWORK") { tabState.anchorSource = "NETWORK"; tabState.anchorSourceAt = Date.now() }
  }

  tabState.hasAnchor = true; tabState.anchorIndex = chunkIndex; tabState.anchorRetainedByRefresh = false
  if (typeof tabState.mediaSequence === "number") tabState.anchorMediaSequence = tabState.mediaSequence + chunkIndex
  if (typeof ns.scheduleWarmRecoveryPersist === "function") ns.scheduleWarmRecoveryPersist()
  if (typeof ns.tryResolveSpeculationAtSegment === "function") ns.tryResolveSpeculationAtSegment(tabId, chunkIndex, { resolve_source: "chunk-observed", bitrate_tier_used: tabState.activeRungLabel || null })
  if (typeof ns.resolveSeekPredictionActual === "function") ns.resolveSeekPredictionActual(tabId, chunkIndex, { source: "player-segment" })
  if (typeof ns.noteRefreshRecoverySuccess === "function") ns.noteRefreshRecoverySuccess(tabId, tabState)

  if (hadAnchor && typeof previousAnchorIndex === "number" && chunkIndex !== previousAnchorIndex) {
    if (typeof ns.noteAnchorChange === "function") ns.noteAnchorChange(tabState, previousAnchorIndex, chunkIndex)
  }

  if (!hadAnchor) {
    tabState.lastScheduledFromIndex = -1
    addLog("INFO", `Player anchor acquired at manifest index ${chunkIndex}/${tabState.segments.length - 1} (tab ${tabId})`)
  } else if (typeof previousAnchorIndex === "number" && Math.abs(chunkIndex - previousAnchorIndex) > Math.max(Number(state.settings.prefetchWindow) * 2, 8)) {
    const playlistJustRefreshed = Date.now() - Number(tabState.playlistRefreshedAt || 0) < 8_000
    const retainedDrift = wasRetainedAnchor || (playlistJustRefreshed && Math.abs(chunkIndex - previousAnchorIndex) <= 4)
    if (chunkIndex < previousAnchorIndex) tabState.lastScheduledFromIndex = -1

    if (retainedDrift) {
      addLog("INFO", `Playlist refresh anchor drift ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId}); skipping seek-churn handling`)
    } else if (Math.abs(chunkIndex - previousAnchorIndex) > 1) {
      const teleportThreshold = Number(constants.TELEPORT_MODE_JUMP_THRESHOLD) || 20
      const staleBackwardTeleport = previousAnchorIndex > 10 && chunkIndex < previousAnchorIndex - 10 && ((chunkIndex <= 2 && typeof ns.shouldBlockStaleTimelineSeekTarget === "function" && ns.shouldBlockStaleTimelineSeekTarget(tabState, chunkIndex)) || (typeof ns.isVariantSwitchGraceActive === "function" && ns.isVariantSwitchGraceActive(tabState)) || ns.isTabInSeekChurnAggressive(tabState))
      if (staleBackwardTeleport) {
        tabState.anchorIndex = previousAnchorIndex; tabState.hasAnchor = true
        addLog("DEBUG", `Skipped stale chunk-observed teleport ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId})`)
        if (typeof ns.maybeReconcileAnchor === "function") ns.maybeReconcileAnchor(tabId, tabState)
      } else if (Math.abs(chunkIndex - previousAnchorIndex) >= teleportThreshold) {
        if (typeof ns.enterTeleportMode === "function") ns.enterTeleportMode(tabId, tabState, chunkIndex, "anchor-jump")
        if (typeof ns.recordTeleportHard === "function") ns.recordTeleportHard()
      } else {
        if (typeof ns.noteAnchorJump === "function") ns.noteAnchorJump(tabId)
        if (typeof ns.applyAnchorJumpCooldown === "function") ns.applyAnchorJumpCooldown(tabState, previousAnchorIndex, chunkIndex)
        ns.markSeekChurnAggressive(tabState)
        addLog("INFO", `Player anchor jumped from ${previousAnchorIndex} -> ${chunkIndex} (tab ${tabId})`)
      }
    }
  }

  if (typeof ns.isTabEligibleForPrefetch === "function" && ns.isTabEligibleForPrefetch(tabId) && (!ns.isTabInAnchorCooldown(tabState) || ns.isTabInTeleportMode(tabState)) && (!ns.isTabInRapidSeek(tabState) || ns.isTabInSeekChurnAggressive(tabState))) {
    const prefetchStart = chunkIndex + 1
    if (!ns.segmentIndexHasActivePrefetch(tabId, tabState, prefetchStart)) ns.maybeRequestPrefetchForTab(tabId, tabState.segments, prefetchStart, "chunk-observed")
  }

  if (typeof ns.maybeScheduleSpeculativePrefetch === "function" && !(typeof ns.isRescueModeActive === "function" && ns.isRescueModeActive(tabState))) ns.maybeScheduleSpeculativePrefetch(tabId)
}
})()
