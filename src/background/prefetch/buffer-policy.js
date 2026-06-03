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
  const healthEmergency = healthScore < 22 && runwaySec < 20
  const healthAggressive = healthScore < 42 && runwaySec < 25
  if (runwaySec < constants.BUFFER_RUNWAY_EMERGENCY_SEC || healthEmergency) {
    return TIER_EMERGENCY
  }
  if (runwaySec < constants.BUFFER_RUNWAY_AGGRESSIVE_SEC || healthAggressive) {
    return TIER_AGGRESSIVE
  }
  if (runwaySec < constants.BUFFER_RUNWAY_NORMAL_SEC) return TIER_NORMAL
  if (runwaySec < constants.BUFFER_RUNWAY_MAINTENANCE_SEC) return TIER_MAINTENANCE
  return TIER_IDLE
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
    } else if (tier === TIER_MAINTENANCE || tier === TIER_IDLE) {
      addLog(
        "INFO",
        `Buffer ${tier} on tab ${tabId} (runway=${runwaySec.toFixed(1)}s, health=${scoreLabel}) — maintenance prefetch only`
      )
    }
  }
}

function resolveBufferAdjustedPrefetchWindow(tabId, baseWindow) {
  if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) {
    return 0
  }
  const tabState = state.playlistByTab.get(tabId)
  if (
    tabState &&
    typeof ns.isTabInRapidSeek === "function" &&
    ns.isTabInRapidSeek(tabState)
  ) {
    return Math.max(1, Math.min(baseWindow, 2))
  }
  if (
    tabState &&
    typeof ns.isTabInAnchorCooldown === "function" &&
    ns.isTabInAnchorCooldown(tabState)
  ) {
    return Math.max(1, Math.min(baseWindow, 2))
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
      adjusted = Math.max(1, Math.min(baseWindow, 2))
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
  const tier = getTabBufferTier(tabId)
  if (!tier) return base

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
  if (typeof ns.resolvePanicAdjustedGlobalCap === "function") {
    return ns.resolvePanicAdjustedGlobalCap(adjusted)
  }
  return adjusted
}

function resolvePagePrefetchConcurrency(tierOrRunway, healthScore) {
  const tier =
    typeof tierOrRunway === "string"
      ? tierOrRunway
      : classifyTierFromRunway(Number(tierOrRunway), Number(healthScore))

  switch (tier) {
    case TIER_EMERGENCY:
      return Math.min(5, constants.PREFETCH_CONCURRENCY + 2)
    case TIER_AGGRESSIVE:
      return Math.min(4, constants.PREFETCH_CONCURRENCY + 1)
    case TIER_NORMAL:
      return constants.PREFETCH_CONCURRENCY
    case TIER_MAINTENANCE:
    case TIER_IDLE:
      return 1
    default:
      return constants.PREFETCH_CONCURRENCY
  }
}

function isMaintenancePrefetchTier(tier) {
  return tier === TIER_MAINTENANCE || tier === TIER_IDLE
}

ns.getTabBufferTier = getTabBufferTier
ns.updateTabBufferHealth = updateTabBufferHealth
ns.resolveBufferAdjustedPrefetchWindow = resolveBufferAdjustedPrefetchWindow
ns.resolveBufferAdjustedGlobalCap = resolveBufferAdjustedGlobalCap
ns.resolvePagePrefetchConcurrency = resolvePagePrefetchConcurrency
ns.isMaintenancePrefetchTier = isMaintenancePrefetchTier
})()
