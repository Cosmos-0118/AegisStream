(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

const TIER_EMERGENCY = "emergency"
const TIER_AGGRESSIVE = "aggressive"
const TIER_NORMAL = "normal"
const TIER_MAINTENANCE = "maintenance"
const TIER_IDLE = "idle"

function getTabBufferState(tabId) {
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState) return null
  const updatedAt = Number(tabState.bufferUpdatedAt || 0)
  if (updatedAt > 0 && Date.now() - updatedAt > constants.BUFFER_HEALTH_STALE_MS) {
    return null
  }
  return tabState
}

function getTabBufferTier(tabId) {
  const tabState = getTabBufferState(tabId)
  const tier = tabState?.bufferTier
  if (typeof tier === "string" && tier.length > 0) return tier
  const runway = Number(tabState?.bufferRunwaySec)
  if (!Number.isFinite(runway)) return null
  return classifyTierFromRunway(runway, Number(tabState?.bufferHealthScore))
}

function classifyTierFromRunway(runwaySec, healthScore = 50) {
  const secureRunway = Number(constants.BUFFER_HEALTH_SECURE_RUNWAY_SEC) || 15
  let tier
  if (runwaySec < constants.BUFFER_RUNWAY_EMERGENCY_SEC) tier = TIER_EMERGENCY
  else if (runwaySec < constants.BUFFER_RUNWAY_AGGRESSIVE_SEC) tier = TIER_AGGRESSIVE
  else if (runwaySec < constants.BUFFER_RUNWAY_NORMAL_SEC) tier = TIER_NORMAL
  else if (runwaySec < constants.BUFFER_RUNWAY_MAINTENANCE_SEC) tier = TIER_MAINTENANCE
  else tier = TIER_IDLE

  if (runwaySec >= secureRunway && (tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE)) {
    tier = runwaySec < constants.BUFFER_RUNWAY_NORMAL_SEC ? TIER_NORMAL : TIER_MAINTENANCE
  }
  return tier
}

function shouldPushBufferLoad(runwaySec, healthScore, tier) {
  if (!Number.isFinite(runwaySec)) return false
  const pushRunway = Number(constants.BUFFER_LOAD_PUSH_RUNWAY_SEC) || 20
  if (tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE) return true
  if (runwaySec < pushRunway) return true
  if (Number.isFinite(healthScore) && healthScore < 35 && runwaySec < pushRunway + 10) {
    return true
  }
  return false
}

function maybePushBufferLoad(tabId, tabState, runwaySec, healthScore, tier) {
  if (!tabState?.segments?.length) return
  if (!shouldPushBufferLoad(runwaySec, healthScore, tier)) return

  const minGap = Number(constants.BUFFER_LOAD_PUSH_MIN_MS) || 1_200
  const now = Date.now()
  if (now - Number(tabState.lastBufferLoadPushAt || 0) < minGap) return
  tabState.lastBufferLoadPushAt = now

  if (typeof ns.notifyPageBufferLoadPush === "function") {
    ns.notifyPageBufferLoadPush(tabId, { tier, runwaySec, healthScore })
  }

  const anchor =
    typeof ns.getEffectiveAnchorIndex === "function"
      ? ns.getEffectiveAnchorIndex(tabState)
      : typeof tabState.anchorIndex === "number"
        ? tabState.anchorIndex
        : 0
  const windowOverride =
    tier === TIER_EMERGENCY
      ? 12
      : tier === TIER_AGGRESSIVE
        ? 10
        : 8

  if (typeof ns.maybeRequestPrefetchForTab === "function") {
    ns.maybeRequestPrefetchForTab(tabId, tabState.segments, Math.max(0, anchor), "buffer-load-push", {
      force: true,
      priority: "high",
      prefetchWindowOverride: windowOverride
    })
  }

  if (
    tier === TIER_EMERGENCY &&
    typeof ns.arbitrateTabStreaming === "function" &&
    typeof ns.executeRescuePrefetch === "function"
  ) {
    const mode = ns.arbitrateTabStreaming(tabState)
    if (mode === ns.EngineModes?.RESCUE) {
      void ns.executeRescuePrefetch(tabId, tabState, tabState.segments, {
        source: "buffer-load-push"
      })
    }
  }
}

function updateTabBufferHealth(tabId, payload) {
  if (!Number.isFinite(tabId) || !payload) return
  let tabState = state.playlistByTab.get(tabId)
  if (!tabState) {
    tabState = { segments: [], updatedAt: Date.now() }
    state.playlistByTab.set(tabId, tabState)
  }

  const runwaySec = Number(payload.runwaySec)
  const healthScore = Number(payload.healthScore)
  const tier =
    typeof payload.tier === "string"
      ? payload.tier
      : classifyTierFromRunway(runwaySec, healthScore)

  const previousTier = tabState.bufferTier || "unknown"

  tabState.bufferRunwaySec = runwaySec
  tabState.bufferRunwayPct = Number(payload.runwayPct)
  tabState.bufferHealthScore = healthScore
  tabState.bufferTier = tier
  tabState.bufferNetFillRate = payload.netFillRate
  tabState.bufferUpdatedAt = Date.now()

  if (
    Number.isFinite(runwaySec) &&
    runwaySec >= 20 &&
    tabState.refreshState === "recovering" &&
    typeof ns.transitionTabRefreshState === "function"
  ) {
    ns.transitionTabRefreshState(tabId, tabState, "healthy", "runway restored")
  }

  if (previousTier !== tier) {
    const scoreLabel = Number.isFinite(healthScore) ? `${healthScore}%` : "n/a"
    const reactive =
      typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)
    if (reactive) {
      addLog(
        "DEBUG",
        `Buffer ${tier} on tab ${tabId} (runway=${runwaySec.toFixed(1)}s, health=${scoreLabel}) — Twitch reactive passthrough (prefetch/cache intercept off)`
      )
    } else if (tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE) {
      addLog(
        "INFO",
        `Buffer ${tier} on tab ${tabId} (runway=${runwaySec.toFixed(1)}s, health=${scoreLabel}) — increasing prefetch`
      )
      if (
        tier === TIER_EMERGENCY &&
        tabState.segments?.length &&
        typeof ns.arbitrateTabStreaming === "function" &&
        typeof ns.executeRescuePrefetch === "function"
      ) {
        const mode = ns.arbitrateTabStreaming(tabState)
        if (mode === ns.EngineModes?.RESCUE) {
          void ns.executeRescuePrefetch(tabId, tabState, tabState.segments, {
            source: "buffer-emergency"
          })
        }
      }
    } else if (tier === TIER_MAINTENANCE || tier === TIER_IDLE) {
      addLog(
        "INFO",
        `Buffer ${tier} on tab ${tabId} (runway=${runwaySec.toFixed(1)}s, health=${scoreLabel}) — maintenance prefetch only`
      )
    }
  }

  const reactive =
    typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)
  if (!reactive) {
    maybePushBufferLoad(tabId, tabState, runwaySec, healthScore, tier)
  }

  if (
    Number.isFinite(runwaySec) &&
    runwaySec >= constants.SPECULATIVE_MIN_RUNWAY_SEC &&
    typeof ns.maybeScheduleSpeculativePrefetch === "function"
  ) {
    ns.maybeScheduleSpeculativePrefetch(tabId)
  }
}

function isTabInSeekChurnAggressive(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.seekChurnAggressiveUntil || 0)
}

function isTabInTeleportMode(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.teleportModeUntil || 0)
}

function resolveBufferAdjustedPrefetchWindow(tabId, baseWindow) {
  if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) {
    return 0
  }
  const tabState = state.playlistByTab.get(tabId)
  const churnMin = Math.max(
    baseWindow,
    Number(constants.SEEK_CHURN_PREFETCH_WINDOW_MIN) || 10
  )
  if (tabState && (isTabInSeekChurnAggressive(tabState) || isTabInTeleportMode(tabState))) {
    return Math.min(20, Math.max(churnMin, Math.ceil(baseWindow * 1.5)))
  }
  if (
    tabState &&
    typeof ns.isTabInAnchorCooldown === "function" &&
    ns.isTabInAnchorCooldown(tabState) &&
    !isTabInTeleportMode(tabState)
  ) {
    return Math.max(1, Math.min(baseWindow, 4))
  }
  const tier = getTabBufferTier(tabId)
  if (!tier) return baseWindow

  let adjusted = baseWindow
  switch (tier) {
    case TIER_EMERGENCY:
      adjusted = Math.min(20, Math.max(baseWindow, Math.ceil(baseWindow * 1.75)))
      break
    case TIER_AGGRESSIVE:
      adjusted = Math.min(20, Math.max(baseWindow, Math.ceil(baseWindow * 1.35)))
      break
    case TIER_NORMAL:
      adjusted = baseWindow
      break
    case TIER_MAINTENANCE:
      if (tabState && isTabInSeekChurnAggressive(tabState)) {
        adjusted = Math.max(churnMin, Math.min(baseWindow, 6))
      } else {
        adjusted = Math.max(1, Math.min(baseWindow, 2))
      }
      break
    case TIER_IDLE:
      adjusted = 1
      break
    default:
      adjusted = baseWindow
  }
  if (typeof ns.resolvePanicAdjustedPrefetchWindow === "function") {
    return ns.resolvePanicAdjustedPrefetchWindow(adjusted)
  }
  return adjusted
}

function resolveBufferAdjustedGlobalCap(tabId) {
  const base = Math.max(1, Number(constants.GLOBAL_MAX_INFLIGHT_PREFETCHES) || 6)
  const tabState = state.playlistByTab.get(tabId)
  const healthScore = Number(tabState?.bufferHealthScore)
  const deficitFloor = Number.isFinite(healthScore) ? getRequiredConcurrency(healthScore) : 0
  const tier = getTabBufferTier(tabId)
  if (!tier) return Math.max(base, deficitFloor)

  let adjusted = base
  switch (tier) {
    case TIER_EMERGENCY:
      adjusted = Math.min(24, base + 8)
      break
    case TIER_AGGRESSIVE:
      adjusted = Math.min(20, base + 4)
      break
    case TIER_NORMAL:
      adjusted = base
      break
    case TIER_MAINTENANCE:
      adjusted = Math.max(4, Math.ceil(base * 0.5))
      break
    case TIER_IDLE:
      adjusted = 2
      break
    default:
      adjusted = base
  }
  adjusted = Math.max(adjusted, deficitFloor)
  if (
    tabState &&
    (isTabInSeekChurnAggressive(tabState) || isTabInTeleportMode(tabState))
  ) {
    adjusted = Math.max(adjusted, Math.min(16, base + 8))
  }
  if (tabState && Date.now() < Number(tabState.scrubFeedSurgeUntil || 0)) {
    adjusted = Math.max(adjusted, Math.min(20, Number(constants.PREFETCH_SCRUB_GLOBAL_INFLIGHT_FLOOR) || 16))
  }
  if (typeof ns.resolvePanicAdjustedGlobalCap === "function") {
    return ns.resolvePanicAdjustedGlobalCap(adjusted)
  }
  return adjusted
}

function getRequiredConcurrency(healthScore) {
  const score = Number(healthScore)
  if (!Number.isFinite(score)) return constants.PREFETCH_CONCURRENCY
  if (score > 80) return 1
  if (score > 40) return 2
  return 4
}

function resolvePagePrefetchConcurrency(tierOrRunway, healthScore) {
  const score = Number(healthScore)
  if (Number.isFinite(score)) {
    return getRequiredConcurrency(score)
  }
  const tier =
    typeof tierOrRunway === "string"
      ? tierOrRunway
      : classifyTierFromRunway(Number(tierOrRunway), 50)
  if (tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE) {
    return 4
  }
  if (tier === TIER_MAINTENANCE || tier === TIER_IDLE) {
    return 1
  }
  return constants.PREFETCH_CONCURRENCY
}

function isMaintenancePrefetchTier(tier) {
  return tier === TIER_MAINTENANCE || tier === TIER_IDLE
}

ns.getTabBufferTier = getTabBufferTier
ns.updateTabBufferHealth = updateTabBufferHealth
ns.resolveBufferAdjustedPrefetchWindow = resolveBufferAdjustedPrefetchWindow
ns.resolveBufferAdjustedGlobalCap = resolveBufferAdjustedGlobalCap
ns.isTabInSeekChurnAggressive = isTabInSeekChurnAggressive
ns.isTabInTeleportMode = isTabInTeleportMode
ns.getRequiredConcurrency = getRequiredConcurrency
ns.resolvePagePrefetchConcurrency = resolvePagePrefetchConcurrency
ns.isMaintenancePrefetchTier = isMaintenancePrefetchTier
})()
