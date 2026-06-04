(() => {
  var ns = (self.AegisBackground ||= {})
  const { addLog } = ns

  function ensurePrefetchRegistry(tabState) {
    if (!tabState) return new Set()
    if (!(tabState.prefetchDownloadRegistry instanceof Set)) {
      tabState.prefetchDownloadRegistry = new Set()
    }
    return tabState.prefetchDownloadRegistry
  }

  function syncLegacyNetworkGeneration(tabState) {
    if (!tabState) return 0
    const playback = Number(tabState.playbackGeneration)
    if (Number.isFinite(playback)) {
      tabState.networkGeneration = playback
      return playback
    }
    const legacy = Number(tabState.networkGeneration) || 0
    tabState.playbackGeneration = legacy
    return legacy
  }

  function prefetchRegistryKey(tabState, normalizedUrl) {
    const gen = syncLegacyNetworkGeneration(tabState)
    return `${gen}|${normalizedUrl}`
  }

  function broadcastDelegatedPrefetchAbort(tabId, tabState, options = {}) {
    if (!Number.isFinite(tabId) || !tabState) return syncLegacyNetworkGeneration(tabState)
    let generation = syncLegacyNetworkGeneration(tabState)
    if (options.bumpGeneration === true) {
      generation = bumpPlaybackGeneration(tabId, tabState, options.reason || "abort-broadcast")
      return generation
    }
    if (Number.isFinite(options.generation)) {
      generation = Number(options.generation)
    }
    void chrome.tabs
      .sendMessage(tabId, {
        type: "AegisStream:CancelPrefetch",
        networkGeneration: generation,
        playbackGeneration: generation
      })
      .catch(() => {
        // tab may not have content script yet
      })
    if (typeof ns.noteDelegatedAbortBroadcast === "function") {
      ns.noteDelegatedAbortBroadcast()
    }
    if (options.log !== false) {
      addLog(
        "DEBUG",
        `Delegated prefetch abort on tab ${tabId} (playbackGen=${generation}${options.reason ? `, ${options.reason}` : ""})`
      )
    }
    return generation
  }

  const NON_DESTRUCTIVE_LIFECYCLE_SOURCES = new Set([
    "chunk-observed",
    "playlist-refresh",
    "captured-playlist",
    "bridge-ready",
    "schedule",
    "anchor",
    "inflight-retry",
    "cap-retry",
    "speculative",
    "maintenance",
    "visibility-resume",
    "quality-switch-warm",
    "variant-switch-rescue"
  ])

  function normalizeLifecycleEventSource(eventSource) {
    return String(eventSource || "")
      .replace(/^delegate-/, "")
      .toLowerCase()
      .trim()
  }

  function isNonDestructiveLifecycleSource(eventSource) {
    const cleanSource = normalizeLifecycleEventSource(eventSource)
    return NON_DESTRUCTIVE_LIFECYCLE_SOURCES.has(cleanSource)
  }

  const SOFT_SCRUB_DELEGATE_SOURCES = new Set([
    "scrub-velocity-prewarm",
    "scrub-snap-back",
    // Soft anchor commits (purgeQueues=false) schedule with this source; must not reset playback.
    "dom-seeked"
  ])

  function isScrubbingTrainActive(tabState) {
    if (!tabState) return false
    return Date.now() < Number(tabState.scrubbingTrainUntil || 0)
  }

  function isVelocityPrefetchLaneActive(tabState) {
    if (!tabState) return false
    const gap = Number(ns.constants?.SCRUB_DELEGATE_MIN_INTERVAL_MS) || 280
    return Date.now() - Number(tabState.lastScrubVelocityScheduleAt || 0) < gap
  }

  /** Immediate passenger lock from unified seek IPC (closes scrub-train race). */
  function isSeekPredictionPassengerPhase(tabState, now = Date.now()) {
    if (!tabState) return false
    if (now < Number(tabState.unifiedSeekPassengerUntil || 0)) return true
    if (isScrubbingTrainActive(tabState, now)) return true
    if (isVelocityPrefetchLaneActive(tabState)) return true
    if (now < Number(tabState.seekChurnAggressiveUntil || 0)) {
      const idleMs = Number(ns.constants?.SCRUBBING_TRAIN_IDLE_MS) || 1000
      const lastScrub = Number(tabState.lastScrubSeekAt || 0)
      if (lastScrub > 0 && now - lastScrub < idleMs + 400) return true
    }
    return false
  }

  /** Predictor must not schedule/delegate while velocity prewarm or scrub churn owns the lane. */
  function shouldDeferSeekPredictionPrefetch(tabState) {
    return isSeekPredictionPassengerPhase(tabState)
  }

  /** Scrub / soft-anchor schedules forward without invalidating in-flight delegate work. */
  function isSoftScrubDelegateSource(eventSource, tabState = null) {
    const cleanSource = normalizeLifecycleEventSource(eventSource)
    if (SOFT_SCRUB_DELEGATE_SOURCES.has(cleanSource)) return true
    if (cleanSource === "seek-prediction" && shouldDeferSeekPredictionPrefetch(tabState)) {
      return true
    }
    return false
  }

  function isDestructiveDelegateSource(eventSource, tabState = null) {
    return (
      !isNonDestructiveLifecycleSource(eventSource) &&
      !isSoftScrubDelegateSource(eventSource, tabState)
    )
  }

  function isChurnPlaybackBumpThrottled(tabState) {
    if (!tabState) return false
    const inChurn =
      Date.now() < Number(tabState.seekChurnAggressiveUntil || 0) ||
      Date.now() < Number(tabState.scrubbingTrainUntil || 0) ||
      Date.now() < Number(tabState.teleportModeUntil || 0)
    if (!inChurn) return false
    const minMs = Number(ns.constants?.CHURN_PLAYBACK_BUMP_MIN_MS) || 600
    return Date.now() - Number(tabState.lastPlaybackGenerationBumpAt || 0) < minMs
  }

  function evaluateLifecycleAdvancement(tabId, tabState, eventSource, targetIndex) {
    if (!tabState) return false
    const cleanSource = normalizeLifecycleEventSource(eventSource)
    if (
      isNonDestructiveLifecycleSource(eventSource) ||
      isSoftScrubDelegateSource(eventSource, tabState)
    ) {
      bumpPlaylistGeneration(tabState, cleanSource || eventSource)
      if (typeof targetIndex === "number" && Number.isFinite(targetIndex)) {
        tabState.lastObservedIndex = targetIndex
      }
      return false
    }
    const before = syncLegacyNetworkGeneration(tabState)
    bumpPlaybackGeneration(tabId, tabState, eventSource)
    return syncLegacyNetworkGeneration(tabState) > before
  }

  function bumpPlaybackGeneration(tabId, tabState, reason) {
    if (!tabState) return 0
    if (isNonDestructiveLifecycleSource(reason) || isSoftScrubDelegateSource(reason, tabState)) {
      bumpPlaylistGeneration(tabState, reason)
      return syncLegacyNetworkGeneration(tabState)
    }
    if (isChurnPlaybackBumpThrottled(tabState)) {
      if (typeof ns.notePlaybackGenerationBump === "function") {
        ns.notePlaybackGenerationBump(true)
      }
      return syncLegacyNetworkGeneration(tabState)
    }
    const next = (Number(tabState.playbackGeneration) || Number(tabState.networkGeneration) || 0) + 1
    tabState.lastPlaybackGenerationBumpAt = Date.now()
    tabState.playbackGeneration = next
    tabState.networkGeneration = next
    ensurePrefetchRegistry(tabState).clear()
    addLog(
      "DEBUG",
      `Playback generation ${next} on tab ${tabId}${reason ? ` (${reason})` : ""}`
    )
    broadcastDelegatedPrefetchAbort(tabId, tabState, {
      generation: next,
      reason: reason || "playback-bump",
      log: false
    })
    if (typeof ns.notePlaybackGenerationBump === "function") {
      ns.notePlaybackGenerationBump(false)
    }
    return next
  }

  function bumpPlaylistGeneration(tabState, reason) {
    if (!tabState) return 0
    const next = (Number(tabState.playlistGeneration) || 0) + 1
    tabState.playlistGeneration = next
    addLog(
      "DEBUG",
      `Playlist generation ${next}${reason ? ` (${reason})` : ""}`
    )
    return next
  }

  function bumpNetworkGeneration(tabId, tabState, reason) {
    return bumpPlaybackGeneration(tabId, tabState, reason)
  }

  function isCurrentPlaybackGeneration(tabState, generation) {
    if (!tabState) return false
    const msgGen = Number(generation)
    if (!Number.isFinite(msgGen)) return true
    return msgGen === syncLegacyNetworkGeneration(tabState)
  }

  function isCurrentNetworkGeneration(tabState, generation) {
    return isCurrentPlaybackGeneration(tabState, generation)
  }

  function tryRegisterPrefetchDownload(tabState, normalizedUrl) {
    if (!tabState || !normalizedUrl) return false
    const key = prefetchRegistryKey(tabState, normalizedUrl)
    const registry = ensurePrefetchRegistry(tabState)
    if (registry.has(key)) return false
    registry.add(key)
    return true
  }

  function releasePrefetchDownload(tabState, normalizedUrl) {
    if (!tabState || !normalizedUrl) return
    const key = prefetchRegistryKey(tabState, normalizedUrl)
    tabState.prefetchDownloadRegistry?.delete(key)
  }

  ns.bumpPlaybackGeneration = bumpPlaybackGeneration
  ns.bumpPlaylistGeneration = bumpPlaylistGeneration
  ns.evaluateLifecycleAdvancement = evaluateLifecycleAdvancement
  ns.normalizeLifecycleEventSource = normalizeLifecycleEventSource
  ns.isNonDestructiveLifecycleSource = isNonDestructiveLifecycleSource
  ns.isSoftScrubDelegateSource = isSoftScrubDelegateSource
  ns.isSeekPredictionPassengerPhase = isSeekPredictionPassengerPhase
  ns.shouldDeferSeekPredictionPrefetch = shouldDeferSeekPredictionPrefetch
  ns.isVelocityPrefetchLaneActive = isVelocityPrefetchLaneActive
  ns.isDestructiveDelegateSource = isDestructiveDelegateSource
  ns.isChurnPlaybackBumpThrottled = isChurnPlaybackBumpThrottled
  ns.bumpNetworkGeneration = bumpNetworkGeneration
  ns.broadcastDelegatedPrefetchAbort = broadcastDelegatedPrefetchAbort
  ns.isCurrentPlaybackGeneration = isCurrentPlaybackGeneration
  ns.isCurrentNetworkGeneration = isCurrentNetworkGeneration
  ns.tryRegisterPrefetchDownload = tryRegisterPrefetchDownload
  ns.releasePrefetchDownload = releasePrefetchDownload
  ns.prefetchRegistryKey = prefetchRegistryKey
  ns.syncLegacyNetworkGeneration = syncLegacyNetworkGeneration
})()
