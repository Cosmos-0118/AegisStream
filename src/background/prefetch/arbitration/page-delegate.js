(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

ns.notifyPageBufferLoadPush = function notifyPageBufferLoadPush(tabId, payload = {}) {
  if (!Number.isFinite(tabId)) return
  if (typeof payload.runwaySec === "number" && payload.runwaySec > 0) {
    chrome.tabs.sendMessage(tabId, {
      type: "AegisStream:BufferLoadPush",
      tier: payload.tier || null,
      runwaySec: Number(payload.runwaySec),
      healthScore: Number(payload.healthScore)
    }).catch(() => {})
  }
}

ns.notifyPageSeekingStateReset = function notifyPageSeekingStateReset(tabId, options = {}) {
  if (!Number.isFinite(tabId)) return
  if (typeof ns.recordKalmanStateReset === "function") ns.recordKalmanStateReset()
  const variantGraceUntil = options.reason === "variant-switch"
    ? Number(options.variantSwitchGraceUntil) || Date.now() + (Number(constants.VARIANT_SWITCH_GRACE_MS) || 8_000) : 0
  chrome.tabs.sendMessage(tabId, {
    type: "AegisStream:ResetSeekingState",
    reason: options.reason || "manifest-reset",
    anchorIndex: typeof options.anchorIndex === "number" ? Math.round(options.anchorIndex) : null,
    variantSwitchGraceUntil: variantGraceUntil > 0 ? variantGraceUntil : null
  }).catch(() => {})
}

ns.buildPlaylistRotationSyncOptions = function buildPlaylistRotationSyncOptions(tabState) {
  if (!tabState?.lastUpsertUrlsChanged) return {}
  const rotatedAt = Number(tabState.playlistRefreshedAt || 0)
  return rotatedAt > 0 ? { playlistRotatedAt: rotatedAt } : {}
}

function markTransitionWarmup(tabId, tabState, stateName, ttlMs, logReason) {
  if (!Number.isFinite(tabId) || !tabState) return
  if (typeof ns.setTransitionWarmup === "function") {
    ns.setTransitionWarmup(tabId, stateName, ttlMs)
  } else {
    tabState.transitionWarmup = { stateName, expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0) }
  }
  if (logReason && typeof addLog === "function") {
    addLog("DEBUG", `Transition warmup armed (${logReason}) on tab ${tabId} for ${stateName}`)
  }
}

ns.syncKnownSegmentsToPage = function syncKnownSegmentsToPage(tabId, segments, options = {}) {
  if (!segments || !segments.length) return
  if (options.resetSeeking === true) {
    ns.notifyPageSeekingStateReset(tabId, { reason: options.reason || "known-segments-sync", anchorIndex: options.anchorIndex })
  }
  const tabState = state.playlistByTab.get(tabId)
  const now = Date.now()
  const signature = `${segments.length}:${segments[0]}:${segments[segments.length - 1]}`
  const reasonText = String(options.reason || "")
  const shouldForce = reasonText.startsWith("reinject:") || reasonText === "tab-activated" || reasonText === "tab-updated"
  if (tabState && !shouldForce && tabState.lastKnownSyncSignature === signature && now - Number(tabState.lastKnownSyncAt || 0) < 8000) return
  if (tabState) {
    tabState.lastKnownSyncSignature = signature
    tabState.lastKnownSyncAt = now
    tabState.bufferFeedPromotedAt = now
  }

  const transitionSource = /quality-switch-warm|playlist-url-rotation|warm-recovery|next-episode|bridge-ready/i.test(reasonText)
  if (transitionSource) {
    const ttlMs = Number(constants.TRANSITION_WARMUP_MS) || 12_000
    markTransitionWarmup(tabId, tabState, reasonText, ttlMs, reasonText)
    if (tabState) {
      tabState.warmRecovery = true
      tabState.warmRecoveryAppliedAt = now
      tabState.playlistRecaptureRequired = false
    }
  }

  const playbackHint = tabState ? {
    segmentDurations: Array.isArray(tabState.segmentDurations) ? tabState.segmentDurations : null,
    segmentCount: tabState.segments?.length || segments.length,
    totalDuration: tabState.playlistFingerprint?.totalDuration ?? null
  } : null

  chrome.tabs.sendMessage(tabId, {
    type: "AegisStream:KnownSegments",
    urls: segments,
    playbackHint,
    playlistRotatedAt: Number.isFinite(Number(options.playlistRotatedAt)) && Number(options.playlistRotatedAt) > 0 ? Number(options.playlistRotatedAt) : undefined,
    resetSeeking: options.resetSeeking === true,
    anchorIndex: typeof options.anchorIndex === "number" ? options.anchorIndex : undefined,
    reason: options.reason || undefined,
    promoteBuffer: true,
    promoteBufferAt: now,
    sessionKey: tabState?.sessionKey || null,
    pageUrl: tabState?.pageUrl || null
  }).then(() => {
    addLog("INFO", `Synced ${segments.length} known segments to page bridge (tab ${tabId})${String(options.reason || "") ? ` (${options.reason})` : ""}`)
  }).catch((e) => {
    addLog("WARN", `Failed to sync known segments to tab ${tabId}: ${e.message}`)
  })
}

ns.delegatePrefetchToPage = async function delegatePrefetchToPage(tabId, urls, options = {}) {
  if (!urls.length) return true
  const tabState = state.playlistByTab.get(tabId)
  const source = options.source || "delegate"

  if (tabState && options.skipCoalesce !== true) {
    const coalesceMs = Number(constants.DELEGATE_BATCH_COALESCE_MS) || 60
    const generation = typeof ns.syncLegacyNetworkGeneration === "function" ? ns.syncLegacyNetworkGeneration(tabState) : Number(tabState.networkGeneration) || 0
    const pending = tabState.pendingDelegatePrefetch
    if (pending?.timerId && pending.generation === generation && pending.options?.source === source) {
      const seen = new Set(pending.urls)
      for (const url of urls) { if (url && !seen.has(url)) { seen.add(url); pending.urls.push(url) } }
      return true
    }
    if (coalesceMs > 0 && typeof ns.isDestructiveDelegateSource === "function") {
      if (!ns.isDestructiveDelegateSource(source, tabState)) {
        tabState.pendingDelegatePrefetch = {
          urls: [...urls], options: { ...options }, generation,
          timerId: setTimeout(() => ns.flushPendingDelegatePrefetch(tabId), coalesceMs)
        }
        return true
      }
    }
  }

  let networkGeneration = typeof ns.syncLegacyNetworkGeneration === "function" ? ns.syncLegacyNetworkGeneration(tabState) : Number(tabState?.networkGeneration) || 0
  const delegateReason = `delegate-${source}`
  const lifecycleIsDestructive = typeof ns.isDestructiveDelegateSource === "function"
    ? ns.isDestructiveDelegateSource(delegateReason, tabState) || ns.isDestructiveDelegateSource(source, tabState)
    : typeof ns.isNonDestructiveLifecycleSource === "function"
      ? !ns.isNonDestructiveLifecycleSource(delegateReason) && !ns.isNonDestructiveLifecycleSource(source)
      : !/^(chunk-observed|playlist-refresh|captured-playlist|bridge-ready|schedule|scrub-velocity-prewarm|scrub-snap-back|dom-seeked)$/i.test(
          String(typeof ns.normalizeLifecycleEventSource === "function" ? ns.normalizeLifecycleEventSource(source) : source || ""))

  if (!lifecycleIsDestructive && tabState) {
    if (typeof ns.evaluateLifecycleAdvancement === "function") ns.evaluateLifecycleAdvancement(tabId, tabState, delegateReason, null)
    networkGeneration = typeof ns.syncLegacyNetworkGeneration === "function" ? ns.syncLegacyNetworkGeneration(tabState) : Number(tabState.networkGeneration) || networkGeneration
  } else if (tabState && lifecycleIsDestructive && ns.shouldAbortDelegatedBeforeSend(tabState, source)) {
    const baselineGen = typeof ns.syncLegacyNetworkGeneration === "function" ? ns.syncLegacyNetworkGeneration(tabState) : Number(tabState.networkGeneration) || 0
    let advanced = false
    if (typeof ns.evaluateLifecycleAdvancement === "function") { advanced = ns.evaluateLifecycleAdvancement(tabId, tabState, delegateReason, null); networkGeneration = typeof ns.syncLegacyNetworkGeneration === "function" ? ns.syncLegacyNetworkGeneration(tabState) : Number(tabState.networkGeneration) || baselineGen }
    else if (typeof ns.bumpPlaybackGeneration === "function") { networkGeneration = ns.bumpPlaybackGeneration(tabId, tabState, delegateReason); advanced = networkGeneration > baselineGen }
    else if (typeof ns.bumpNetworkGeneration === "function") { networkGeneration = ns.bumpNetworkGeneration(tabId, tabState, delegateReason); advanced = networkGeneration > baselineGen }
    else if (typeof ns.broadcastDelegatedPrefetchAbort === "function") { networkGeneration = ns.broadcastDelegatedPrefetchAbort(tabId, tabState, { reason: delegateReason }); advanced = true }
    if (advanced) ns.releaseInflightForTab(tabId, { notifyPage: false })
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "AegisStream:PrefetchSegments", urls,
      networkGeneration, playbackGeneration: networkGeneration,
      priority: options.priority || "low"
    })
    addLog("INFO", `Delegated prefetch of ${urls.length} segments to page context (tab ${tabId})`)
    return true
  } catch (e) {
    addLog("WARN", `Could not delegate prefetch to tab ${tabId}: ${e.message}`)
    return false
  }
}

ns.flushPendingDelegatePrefetch = function flushPendingDelegatePrefetch(tabId) {
  const tabState = state.playlistByTab.get(tabId)
  const pending = tabState?.pendingDelegatePrefetch
  if (!tabState || !pending) return
  if (pending.timerId) { clearTimeout(pending.timerId); pending.timerId = null }
  tabState.pendingDelegatePrefetch = null
  if (!pending.urls?.length) return
  void ns.delegatePrefetchToPage(tabId, pending.urls, { ...pending.options, source: pending.options?.source || "schedule", skipCoalesce: true })
}
})()
