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
  if (runwaySec < constants.BUFFER_RUNWAY_EMERGENCY_SEC || healthScore < 22) {
    return TIER_EMERGENCY
  }
  if (runwaySec < constants.BUFFER_RUNWAY_AGGRESSIVE_SEC || healthScore < 42) {
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

  if (previousTier !== tier) {
    const scoreLabel = Number.isFinite(healthScore) ? `${healthScore}%` : "n/a"
    if (tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE) {
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
  const tier = getTabBufferTier(tabId)
  if (!tier) return baseWindow

  switch (tier) {
    case TIER_EMERGENCY:
      return Math.min(20, Math.max(baseWindow, Math.ceil(baseWindow * 1.75)))
    case TIER_AGGRESSIVE:
      return Math.min(20, Math.max(baseWindow, Math.ceil(baseWindow * 1.35)))
    case TIER_NORMAL:
      return baseWindow
    case TIER_MAINTENANCE:
      return Math.max(1, Math.min(baseWindow, 2))
    case TIER_IDLE:
      return 1
    default:
      return baseWindow
  }
}

function resolveBufferAdjustedGlobalCap(tabId) {
  const base = Math.max(1, Number(constants.GLOBAL_MAX_INFLIGHT_PREFETCHES) || 6)
  const tier = getTabBufferTier(tabId)
  if (!tier) return base

  switch (tier) {
    case TIER_EMERGENCY:
      return Math.min(24, base + 8)
    case TIER_AGGRESSIVE:
      return Math.min(20, base + 4)
    case TIER_NORMAL:
      return base
    case TIER_MAINTENANCE:
      return Math.max(4, Math.ceil(base * 0.5))
    case TIER_IDLE:
      return 2
    default:
      return base
  }
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
