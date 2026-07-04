(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

const pendingDomAnchorByTab = new Map()
const teleportDebounceByTab = new Map()

ns.softCommitAnchor = function softCommitAnchor(tabId, tabState, targetIndex, source = "anchor-soft-commit") {
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return
  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))
  const previousAnchor = tabState.anchorIndex

  if (typeof ns.resetPassiveAnchorDeferral === "function") {
    ns.resetPassiveAnchorDeferral(tabState)
  } else {
    tabState.anchorPendingIndex = null
    tabState.anchorPendingCount = 0
    tabState.anchorLockStartedAt = 0
  }

  ns.markSeekChurnAggressive(tabState)
  tabState.hasAnchor = true
  tabState.anchorIndex = clampedTarget
  tabState.anchorRetainedByRefresh = false
  tabState.lastScheduledFromIndex = -1
  if (typeof tabState.mediaSequence === "number") {
    tabState.anchorMediaSequence = tabState.mediaSequence + clampedTarget
  }

  if (typeof ns.scheduleWarmRecoveryPersist === "function") {
    ns.scheduleWarmRecoveryPersist()
  }

  addLog("INFO", `Soft anchor commit on tab ${tabId} (${source}): ${previousAnchor ?? "?"} -> ${clampedTarget}, retaining prefetch overlap`)
  const scheduleSource = source || "anchor-soft-commit"
  if (scheduleSource === "dom-seeked" && ns.isTabInScrubbingTrain(tabState)) {
    const now = Date.now()
    const minInterval = Number(constants.SCRUB_DELEGATE_MIN_INTERVAL_MS) || 280
    const lastAt = Number(tabState.lastDomSeekedScheduleAt || 0)
    if (now - lastAt < minInterval) return
    tabState.lastDomSeekedScheduleAt = now
  }
  void ns.schedulePrefetch(tabId, tabState.segments, Math.max(0, clampedTarget - 1), {
    force: true,
    source: scheduleSource
  })
}

function isStaleTimelineDomReset(tabState, previousEffective, clampedTarget) {
  if (typeof previousEffective !== "number" || typeof clampedTarget !== "number") return false
  const len = tabState?.segments?.length || 0
  if (len < 4) return false
  return previousEffective >= len * 0.7 && clampedTarget <= len * 0.12
}

ns.commitAnchorFromAuthority = function commitAnchorFromAuthority(tabId, targetIndex, authority, source = "anchor-authority") {
  if (!Number.isFinite(tabId)) return false
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return false

  const evaluate = typeof ns.evaluateAuthorityCommit === "function" ? ns.evaluateAuthorityCommit : null
  const decision = evaluate
    ? evaluate(tabState, targetIndex, authority)
    : { allow: true, reason: null, jump: ns.anchorJumpForTab(tabState, targetIndex), purgeQueues: false }

  if (!decision.allow) {
    if (authority === ns.AnchorAuthority?.DOM_SEEKED && typeof ns.recordDomSeekSkipped === "function") {
      ns.recordDomSeekSkipped()
    }
    return false
  }

  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))
  const previousCommitted = typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : null
  const previousEffective = typeof ns.getEffectiveAnchorIndex === "function" ? ns.getEffectiveAnchorIndex(tabState) : previousCommitted
  const jumpReference = source === "anchor-reconciliation" ? previousCommitted ?? previousEffective : previousEffective ?? previousCommitted
  const jump = typeof jumpReference === "number" ? Math.abs(clampedTarget - jumpReference) : 0

  if (jump === 0) {
    if (source === "anchor-reconciliation" && typeof previousCommitted === "number" && previousCommitted !== clampedTarget) {
      tabState.hasAnchor = true
      tabState.anchorIndex = clampedTarget
      tabState.anchorSourceAt = Date.now()
      if (typeof tabState.mediaSequence === "number") tabState.anchorMediaSequence = tabState.mediaSequence + clampedTarget
      return true
    }
    return false
  }

  const oldAnchor = typeof jumpReference === "number" ? jumpReference : null
  const scrubbingTrain = ns.isTabInScrubbingTrain(tabState)
  const timelineRestart = authority === ns.AnchorAuthority?.DOM_SEEKED && isStaleTimelineDomReset(tabState, previousEffective, clampedTarget)
  let purgeQueues = scrubbingTrain
    ? false
    : typeof ns.shouldPurgePrefetchQueues === "function"
      ? ns.shouldPurgePrefetchQueues(jump)
      : jump >= (Number(constants.TELEPORT_QUEUE_PURGE_THRESHOLD) || 20)
  if (typeof clampedTarget === "number" && clampedTarget <= 2 && typeof oldAnchor === "number" && oldAnchor > 10) purgeQueues = false
  if (source === "anchor-reconciliation") purgeQueues = false
  if (timelineRestart && !scrubbingTrain) {
    purgeQueues = false
    addLog("INFO", `Timeline restart on tab ${tabId}: DOM ${previousEffective} -> ${clampedTarget} without queue purge (player reload / start over)`)
  }
  if (authority === ns.AnchorAuthority?.DOM_SEEKED) {
    tabState.lastDomTeleportAt = Date.now()
    if (scrubbingTrain || purgeQueues) {
      tabState.mutePassiveHysteresisUntil = Date.now() + (Number(constants.PASSIVE_HYSTERESIS_MUTE_MS) || 1_500)
    }
  }

  ns.pruneInflightSegmentIndices(tabState, clampedTarget)

  tabState.hasAnchor = true
  tabState.anchorIndex = clampedTarget
  tabState.anchorSource = authority === ns.AnchorAuthority?.DOM_SEEKED ? "DOM_SEEKED" : authority === ns.AnchorAuthority?.SEEK_PREDICTION ? "SEEK_PREDICTION" : "NETWORK"
  tabState.anchorSourceAt = Date.now()
  if (typeof tabState.mediaSequence === "number") tabState.anchorMediaSequence = tabState.mediaSequence + clampedTarget

  if (typeof ns.scheduleWarmRecoveryPersist === "function") ns.scheduleWarmRecoveryPersist()
  if (typeof ns.tryResolveSpeculationAtSegment === "function") ns.tryResolveSpeculationAtSegment(tabId, clampedTarget, { resolve_source: source || "dom-seeked", bitrate_tier_used: tabState.activeRungLabel || null })
  if (typeof ns.resetPassiveAnchorDeferral === "function") ns.resetPassiveAnchorDeferral(tabState)
  else {
    tabState.anchorPendingIndex = null
    tabState.anchorPendingCount = 0
    tabState.anchorLockStartedAt = 0
  }

  const label = typeof ns.authorityLabel === "function" ? ns.authorityLabel(authority) : String(authority)
  addLog("INFO", `Anchor authority commit on tab ${tabId} (${label}, ${source}): ${oldAnchor ?? "none"} -> ${clampedTarget}, jump=${jump}, purgeQueues=${purgeQueues}`)
  if (typeof ns.recordAnchorCommit === "function") ns.recordAnchorCommit(authority, { teleport: purgeQueues ? "hard" : "soft" })
  if (typeof ns.recordTimelineHeat === "function") ns.recordTimelineHeat(tabId, clampedTarget, 1)

  if (purgeQueues) {
    const scrubRadius = Number(constants.SCRUBBING_TRAIN_PREFETCH_RADIUS) || 2
    ns.enterTeleportMode(tabId, tabState, clampedTarget, source, { purgeQueues: true, radius: scrubbingTrain ? scrubRadius : undefined })
  } else {
    ns.softCommitAnchor(tabId, tabState, clampedTarget, source)
  }
  return true
}

ns.maybeReconcileAnchor = function maybeReconcileAnchor(tabId, tabState, now = Date.now()) {
  if (!tabState?.segments?.length) return false
  if (typeof ns.evaluateAnchorReconciliation !== "function") return false
  const decision = ns.evaluateAnchorReconciliation(tabState, now)
  if (!decision.promote || typeof decision.targetIndex !== "number") return false

  const authority = ns.AnchorAuthority?.SEEK_PREDICTION ?? 2
  addLog("INFO", `Anchor reconciliation on tab ${tabId}: anchor=${tabState.anchorIndex ?? "none"} -> consensus=${decision.targetIndex} (divergence=${decision.divergence ?? "?"}, ${decision.reason})`)
  const committed = ns.commitAnchorFromAuthority(tabId, decision.targetIndex, authority, "anchor-reconciliation")
  if (typeof ns.markAnchorReconciliationPromoted === "function") ns.markAnchorReconciliationPromoted(tabState, now)
  return committed
}

ns.anchorJumpForTab = function anchorJumpForTab(tabState, targetIndex) {
  if (typeof ns.anchorJump === "function") return ns.anchorJump(tabState, targetIndex)
  if (typeof ns.getEffectiveAnchorIndex === "function") {
    const current = ns.getEffectiveAnchorIndex(tabState)
    if (typeof current !== "number" || typeof targetIndex !== "number") return 0
    return Math.abs(targetIndex - current)
  }
  const current = typeof tabState?.anchorIndex === "number" ? tabState.anchorIndex : null
  if (typeof current !== "number" || typeof targetIndex !== "number") return 0
  return Math.abs(targetIndex - current)
}

function flushPendingDomAnchorCommit(tabId) {
  const pending = pendingDomAnchorByTab.get(tabId)
  if (!pending) return
  pendingDomAnchorByTab.delete(tabId)
  if (pending.timer) { clearTimeout(pending.timer); pending.timer = null }
  const authority = ns.AnchorAuthority?.DOM_SEEKED ?? 3
  const targetIndex = pending.targetIndex
  if (typeof targetIndex !== "number") return
  ns.commitAnchorFromAuthority(tabId, targetIndex, authority, pending.source || "dom-seeked")
}

ns.scheduleDomAnchorCommit = function scheduleDomAnchorCommit(tabId, targetIndex, payload = {}) {
  if (!Number.isFinite(tabId) || typeof targetIndex !== "number") return
  const tabState = state.playlistByTab.get(tabId)
  let pending = pendingDomAnchorByTab.get(tabId)
  if (!pending) {
    pending = { targetIndex, source: payload.source, timer: null, coalescedCount: 0 }
    pendingDomAnchorByTab.set(tabId, pending)
  }
  pending.targetIndex = targetIndex
  pending.source = payload.source || pending.source
  pending.coalescedCount = Number(pending.coalescedCount || 0) + 1
  if (pending.timer) clearTimeout(pending.timer)
  const delay = ns.isTabInScrubbingTrain(tabState)
    ? Number(constants.SCRUB_DOM_ANCHOR_COALESCE_MS) || 120
    : Number(constants.DOM_ANCHOR_COALESCE_MS) || 40
  pending.timer = setTimeout(() => { flushPendingDomAnchorCommit(tabId) }, delay)
}

ns.shouldSuppressVariantSwitchTeleport = function shouldSuppressVariantSwitchTeleport(tabState, targetIndex, payload = {}) {
  if (!ns.isTabInVariantSwitchGrace(tabState)) return false
  const retained = tabState.variantSwitchAnchorIndex
  if (typeof retained !== "number" || typeof targetIndex !== "number") return false
  if (targetIndex >= retained - 2) return false
  const currentTime = Number(payload.currentTimeSec)
  const suppressSec = Number(constants.VARIANT_SWITCH_TELEPORT_SUPPRESS_SEC) || 20
  if (Number.isFinite(currentTime)) return currentTime < suppressSec
  const earlyBound = Math.max(2, Math.floor(retained * 0.1))
  return targetIndex <= earlyBound
}

ns.scheduleVariantSwitchWarmPrefetch = function scheduleVariantSwitchWarmPrefetch(tabId, tabState) {
  if (!tabState?.segments?.length) return
  const anchor = typeof tabState.variantSwitchAnchorIndex === "number" ? tabState.variantSwitchAnchorIndex
    : typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : null
  if (typeof anchor !== "number") return
  ns.markSeekChurnAggressive(tabState)
  ns.maybeRequestPrefetchForTab(tabId, tabState.segments, Math.max(0, anchor), "quality-switch-warm", {
    force: true,
    prefetchWindowOverride: Number(constants.VARIANT_SWITCH_PREFETCH_WINDOW) || 12
  })
}

function enterTeleportModeImmediate(tabId, tabState, targetIndex, source = "teleport", options = {}) {
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return
  const now = Date.now()
  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))

  if (options.purgeQueues !== true && typeof ns.activateOrExtendTeleportLease === "function") {
    const lease = ns.activateOrExtendTeleportLease(tabState, clampedTarget, now)
    if (lease?.extended) {
      tabState.hasAnchor = true
      tabState.anchorIndex = clampedTarget
      tabState.lastScheduledFromIndex = -1
      addLog("INFO", `Teleport lease extended on tab ${tabId}: index ${lease.previous ?? "?"} -> ${lease.target}`)
      const radius = Math.max(1, Number(options.radius) ||
        (Date.now() < Number(tabState.scrubSnapBackUntil || 0) ? Number(constants.SCRUB_SNAP_BACK_RADIUS) || 15
          : ns.isTabInScrubbingTrain(tabState) ? Number(constants.SCRUBBING_TRAIN_PREFETCH_RADIUS) || 2
          : Number(constants.TELEPORT_MODE_RADIUS) || 5))
      const start = Math.max(0, clampedTarget - radius)
      void ns.schedulePrefetch(tabId, tabState.segments, start, { force: true, source: source || "teleport-lease" })
      return
    }
  }

  const radius = Math.max(1, Number(options.radius) ||
    (Date.now() < Number(tabState.scrubSnapBackUntil || 0) ? Number(constants.SCRUB_SNAP_BACK_RADIUS) || 15
      : ns.isTabInScrubbingTrain(tabState) ? Number(constants.SCRUBBING_TRAIN_PREFETCH_RADIUS) || 2
      : Number(constants.TELEPORT_MODE_RADIUS) || 5))
  const start = Math.max(0, clampedTarget - radius)
  const previousAnchor = tabState.anchorIndex
  const jump = ns.anchorJumpForTab(tabState, clampedTarget)
  const purgeQueues = options.purgeQueues !== false &&
    (options.purgeQueues === true ||
      (typeof ns.shouldPurgePrefetchQueues === "function" ? ns.shouldPurgePrefetchQueues(jump)
        : jump >= (Number(constants.TELEPORT_QUEUE_PURGE_THRESHOLD) || 20)))

  tabState.teleportModeUntil = now + constants.TELEPORT_MODE_DURATION_MS
  tabState.teleportTargetIndex = clampedTarget
  if (typeof ns.armTeleportPriorityLane === "function") ns.armTeleportPriorityLane(tabState, clampedTarget, now)
  ns.markSeekChurnAggressive(tabState)
  tabState.hasAnchor = true
  tabState.anchorIndex = clampedTarget
  tabState.anchorRetainedByRefresh = false
  tabState.lastScheduledFromIndex = -1
  if (typeof tabState.mediaSequence === "number") tabState.anchorMediaSequence = tabState.mediaSequence + clampedTarget

  if (purgeQueues) {
    if (typeof ns.bumpPlaybackGeneration === "function") ns.bumpPlaybackGeneration(tabId, tabState, source || "teleport-purge")
    else if (typeof ns.bumpNetworkGeneration === "function") ns.bumpNetworkGeneration(tabId, tabState, source || "teleport-purge")
    ns.clearTabFailedPrefetches(tabState)
    tabState.prefetchFailureWindow = null
    ns.cancelPendingPrefetchForTab(tabId)
    if (typeof ns.clearPrefetchCapRetry === "function") ns.clearPrefetchCapRetry(tabState)
    if (typeof ns.clearPrefetchInflightRetry === "function") ns.clearPrefetchInflightRetry(tabState)
    ns.releaseInflightForTab(tabId, { notifyPage: false })
  }

  addLog("INFO", `Teleport mode activated on tab ${tabId} (${source}): anchor=${clampedTarget}/${tabState.segments.length - 1}, prefetching target ring ${start}-${Math.min(tabState.segments.length - 1, clampedTarget + radius)}${purgeQueues ? "" : ", queues retained"}`)
  if (typeof ns.recordSeekPrediction === "function") ns.recordSeekPrediction(tabId, { predictedIndex: clampedTarget, currentTimeSec: null, previousIndex: previousAnchor, teleport: true, source })

  const prefetchSource = purgeQueues ? "teleport-mode" : "teleport-mode-retained"
  void ns.schedulePrefetch(tabId, tabState.segments, start, { force: true, source: prefetchSource })
  if (typeof ns.maybeScheduleSpeculativePrefetch === "function" && !(typeof ns.isRescueModeActive === "function" && ns.isRescueModeActive(tabState))) ns.maybeScheduleSpeculativePrefetch(tabId)
}

ns.enterTeleportMode = function enterTeleportMode(tabId, tabState, targetIndex, source = "teleport", options = {}) {
  if (!tabState?.segments?.length || typeof targetIndex !== "number") return
  const debounceMs = Number(constants.TELEPORT_DEBOUNCE_MS) || 0
  if (debounceMs <= 0) {
    enterTeleportModeImmediate(tabId, tabState, targetIndex, source, options)
    return
  }
  let pending = teleportDebounceByTab.get(tabId)
  if (!pending) {
    pending = { timerId: null, targetIndex, source, options: { ...options } }
    teleportDebounceByTab.set(tabId, pending)
  } else {
    pending.targetIndex = targetIndex
    pending.source = source
    pending.options = { ...options }
  }
  if (pending.timerId) clearTimeout(pending.timerId)
  pending.timerId = setTimeout(() => {
    const debouncedTarget = pending.targetIndex
    const debouncedSource = pending.source
    const debouncedOptions = { ...pending.options }
    teleportDebounceByTab.delete(tabId)
    const latestTabState = state.playlistByTab.get(tabId)
    if (!latestTabState) return
    enterTeleportModeImmediate(tabId, latestTabState, debouncedTarget, debouncedSource, debouncedOptions)
  }, debounceMs)
}

ns.handleForceTeleportAnchor = function handleForceTeleportAnchor(tabId, payload = {}) {
  if (!Number.isFinite(tabId)) return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length) return

  let targetIndex = Number(payload.index)
  if (!Number.isFinite(targetIndex) && Number.isFinite(Number(payload.currentTimeSec))) {
    targetIndex = ns.estimateManifestIndexFromTime(Number(payload.currentTimeSec), tabState.segmentDurations, {
      totalDurationSec: tabState.playlistFingerprint?.totalDuration,
      segmentCount: tabState.segments.length,
      fallbackSegmentDurationSec: 4
    })
  }
  if (!Number.isFinite(targetIndex)) return
  const clampedTarget = Math.max(0, Math.min(targetIndex, tabState.segments.length - 1))

  if (ns.shouldSuppressVariantSwitchTeleport(tabState, clampedTarget, payload)) {
    addLog("DEBUG", `Suppressed variant-switch DOM teleport on tab ${tabId}: index ${clampedTarget} (retained ${tabState.variantSwitchAnchorIndex}, t=${Number(payload.currentTimeSec).toFixed?.(2) ?? payload.currentTimeSec}s)`)
    ns.scheduleVariantSwitchWarmPrefetch(tabId, tabState)
    return
  }
  if (typeof ns.shouldBlockStaleTimelineSeekTarget === "function" && ns.shouldBlockStaleTimelineSeekTarget(tabState, clampedTarget)) {
    addLog("DEBUG", `Suppressed stale DOM teleport on tab ${tabId}: index ${clampedTarget} (effective ${typeof ns.getEffectiveAnchorIndex === "function" ? ns.getEffectiveAnchorIndex(tabState) : tabState.anchorIndex}, t=${Number(payload.currentTimeSec).toFixed?.(2) ?? payload.currentTimeSec}s)`)
    ns.maybeReconcileAnchor(tabId, tabState)
    return
  }
  if (typeof ns.armTeleportPriorityLane === "function") ns.armTeleportPriorityLane(tabState, clampedTarget)
  ns.scheduleDomAnchorCommit(tabId, clampedTarget, payload)
}

ns.evaluateAnchorCommit = function evaluateAnchorCommit(tabState, chunkIndex, previousAnchorIndex, hadAnchor) {
  const NEARBY_DELTA = 2
  const resetDeferral = typeof ns.resetPassiveAnchorDeferral === "function"
    ? ns.resetPassiveAnchorDeferral
    : (s) => { if (!s) return; s.anchorPendingIndex = null; s.anchorPendingCount = 0; s.anchorLockStartedAt = 0 }

  if (!hadAnchor || typeof previousAnchorIndex !== "number") {
    resetDeferral(tabState)
    return { accept: true, index: chunkIndex }
  }

  if (ns.isPassiveHysteresisMuted(tabState)) {
    if (Math.abs(chunkIndex - previousAnchorIndex) > NEARBY_DELTA) return { accept: false, index: previousAnchorIndex, reason: "passive-muted" }
    resetDeferral(tabState)
    return { accept: true, index: chunkIndex }
  }

  if (ns.isTabInTeleportMode(tabState) && typeof tabState.teleportTargetIndex === "number") {
    const radius = Math.max(1, Number(constants.TELEPORT_MODE_RADIUS) || 5)
    if (Math.abs(chunkIndex - tabState.teleportTargetIndex) <= radius + 2) {
      resetDeferral(tabState)
      return { accept: true, index: chunkIndex }
    }
  }

  const jump = Math.abs(chunkIndex - previousAnchorIndex)
  const isZeroReset = chunkIndex === 0 && previousAnchorIndex > 10
  const isExtremeJump = jump > Number(constants.ANCHOR_TELEPORT_JUMP_THRESHOLD || 5)
  const playlistGrace = Date.now() - Number(tabState.playlistRefreshedAt || 0) < constants.PLAYLIST_ROTATION_GRACE_MS

  if (!isExtremeJump && !isZeroReset) {
    resetDeferral(tabState)
    return { accept: true, index: chunkIndex }
  }

  if (playlistGrace || tabState.anchorRetainedByRefresh === true) {
    if (isZeroReset && typeof ns.shouldBlockStaleTimelineSeekTarget === "function" && ns.shouldBlockStaleTimelineSeekTarget(tabState, chunkIndex)) {
      return { accept: false, index: previousAnchorIndex, reason: "retained-stale-zero" }
    }
    return { accept: true, index: chunkIndex }
  }

  const evaluatePassive = typeof ns.evaluatePassiveAnchorSignal === "function" ? ns.evaluatePassiveAnchorSignal : null
  if (evaluatePassive) {
    const resolved = evaluatePassive(tabState, chunkIndex, previousAnchorIndex)
    if (resolved !== previousAnchorIndex) return { accept: true, index: resolved, via: "monotonic-breakthrough" }
    return { accept: false, index: previousAnchorIndex, reason: isZeroReset ? "zero-reset-hysteresis" : "teleport-hysteresis" }
  }

  return { accept: true, index: chunkIndex }
}

ns.shouldRejectAnchorRegression = function shouldRejectAnchorRegression(tabState, previousAnchorIndex, chunkIndex) {
  if (typeof previousAnchorIndex !== "number" || typeof chunkIndex !== "number") return false
  if (chunkIndex <= 2 && previousAnchorIndex > 10 && typeof ns.shouldBlockStaleTimelineSeekTarget === "function" && ns.shouldBlockStaleTimelineSeekTarget(tabState, chunkIndex)) return true

  const prefetchWindow = Math.max(Number(state.settings?.prefetchWindow) || 8, 1)
  const threshold = Math.max(prefetchWindow * 2, 8)
  if (chunkIndex >= previousAnchorIndex - threshold) return false

  const backwardJump = previousAnchorIndex - chunkIndex
  if (backwardJump >= 10 && previousAnchorIndex > 15 &&
    (ns.isTabInSeekChurnAggressive(tabState) || (typeof ns.isVariantSwitchGraceActive === "function" && ns.isVariantSwitchGraceActive(tabState)))) return true

  const teleportThreshold = Number(constants.ANCHOR_TELEPORT_JUMP_THRESHOLD) || 5
  if (backwardJump >= teleportThreshold) return false
  if (ns.isTabInSeekChurnAggressive(tabState) || ns.isTabInTeleportMode(tabState) || ns.isTabInRapidSeek(tabState)) return false

  const now = Date.now()
  const playlistGrace = now - Number(tabState.playlistRefreshedAt || 0) < constants.PLAYLIST_ROTATION_GRACE_MS
  const rotationGrace = now < Number(tabState.anchorRotationGraceUntil || 0)
  const retained = tabState.anchorRetainedByRefresh === true && playlistGrace
  return playlistGrace || rotationGrace || retained
}

ns.pruneInflightSegmentIndices = function pruneInflightSegmentIndices(tabState, anchorIndex) {
  if (!(tabState?.activeInflightSegmentIndices instanceof Set)) return
  if (typeof anchorIndex !== "number") return
  const prefetchWindow = Math.max(Number(state.settings?.prefetchWindow) || 8, 1)
  const window = Math.max(prefetchWindow * 2, 16)
  const behindGrace = Math.max(1, Number(constants.SCRUB_INFLIGHT_BEHIND_GRACE) || 2)
  const scrubbing = typeof ns.isScrubbingTrainActive === "function" && ns.isScrubbingTrainActive(tabState)
  for (const idx of tabState.activeInflightSegmentIndices) {
    if (Math.abs(idx - anchorIndex) > window) tabState.activeInflightSegmentIndices.delete(idx)
    else if (scrubbing && idx < anchorIndex - behindGrace) tabState.activeInflightSegmentIndices.delete(idx)
  }
}
})()
