(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state } = ns

const TIER_ELITE = "ELITE"
const TIER_NOMINAL = "NOMINAL"
const TIER_CONGESTED = "CONGESTED"
const TIER_PANIC = "PANIC"

const CONGESTION_TIERS = {
  [TIER_ELITE]: { maxTtfb: 50, maxInflight: 12, runwaySpeculativeMin: 30 },
  [TIER_NOMINAL]: { maxTtfb: 200, maxInflight: 8, runwaySpeculativeMin: 20 },
  [TIER_CONGESTED]: { maxTtfb: 500, maxInflight: 5, runwaySpeculativeMin: Infinity },
  [TIER_PANIC]: { maxTtfb: Infinity, maxInflight: 3, runwaySpeculativeMin: Infinity }
}

const SCRUB_GUARD_RADIUS_FLOOR = 15
const SCRUB_GUARD_RADIUS_CEILING = 20

function isScrubGuardActive(tabState) {
  if (!tabState) return false
  const now = Date.now()
  if (now < Number(tabState.scrubSnapBackUntil || 0)) return true
  if (
    typeof ns.isTabInSeekChurnAggressive === "function" &&
    ns.isTabInSeekChurnAggressive(tabState)
  ) {
    return true
  }
  return false
}

function resolveCongestionTierKey(ttfb, options = {}) {
  if (options.panicActive === true) return TIER_PANIC
  if (ttfb <= CONGESTION_TIERS[TIER_ELITE].maxTtfb) return TIER_ELITE
  if (ttfb <= CONGESTION_TIERS[TIER_NOMINAL].maxTtfb) return TIER_NOMINAL
  if (ttfb <= CONGESTION_TIERS[TIER_CONGESTED].maxTtfb) return TIER_CONGESTED
  return TIER_PANIC
}

function computeDynamicRadius(baseRadius, tierKey, tabState) {
  const base = Math.max(1, Number(baseRadius) || 1)
  let radius = base

  if (tierKey === TIER_ELITE) {
    radius = Math.min(30, base * 2)
  } else if (tierKey === TIER_CONGESTED) {
    radius = Math.max(6, Math.floor(base * 0.75))
  } else if (tierKey === TIER_PANIC) {
    radius = 4
  }

  if (isScrubGuardActive(tabState)) {
    radius = Math.max(radius, SCRUB_GUARD_RADIUS_FLOOR)
    radius = Math.min(radius, SCRUB_GUARD_RADIUS_CEILING)
  }

  return Math.max(1, radius)
}

/**
 * @param {Object} globalStats - state.stats
 * @param {Object|null} tabState - per-tab playlist state
 * @param {number} baseRadius - settings.prefetchWindow fallback
 */
function computeCongestionDirectives(globalStats, tabState, baseRadius = 8) {
  const ttfb = Number(
    globalStats?.networkFirstByteP95Ms ||
      globalStats?.requestFirstByteP95Ms ||
      (typeof ns.getNetworkP95Ms === "function" ? ns.getNetworkP95Ms() : 0) ||
      100
  )
  const runway = Number(tabState?.bufferRunwaySec || 0)
  const bufferTier = tabState?.bufferTier
  const isEmergency = bufferTier === "emergency"
  const panicActive =
    typeof ns.isNetworkPanicActive === "function" && ns.isNetworkPanicActive()

  const tierKey = resolveCongestionTierKey(ttfb, { panicActive })
  const tier = CONGESTION_TIERS[tierKey]
  const prefetchRadius = computeDynamicRadius(baseRadius, tierKey, tabState)

  const speculativeAllowed =
    !isEmergency &&
    !panicActive &&
    tierKey !== TIER_CONGESTED &&
    tierKey !== TIER_PANIC &&
    Number.isFinite(tier.runwaySpeculativeMin) &&
    runway >= tier.runwaySpeculativeMin

  const speculativeSegmentsAhead = speculativeAllowed ? (ttfb <= 50 ? 2 : 1) : 0

  return {
    prefetchRadius,
    maxInflight: tier.maxInflight,
    speculativeAllowed,
    speculativeSegmentsAhead,
    activeTierName: tierKey,
    ttfbP95Ms: ttfb,
    scrubGuardActive: isScrubGuardActive(tabState)
  }
}

function computeCongestionDirectivesForTab(tabId, baseRadius) {
  const tabState = state.playlistByTab.get(tabId) || null
  const base =
    Number.isFinite(baseRadius) && baseRadius > 0
      ? baseRadius
      : Math.max(1, Number(state.settings.prefetchWindow) || 8)
  const directives = computeCongestionDirectives(state.stats, tabState, base)
  if (tabState) {
    tabState.congestionDirectives = directives
    tabState.congestionUpdatedAt = Date.now()
  }
  return directives
}

function applyCongestionPrefetchRadius(tabId, bufferAdjustedWindow) {
  const tabState = state.playlistByTab.get(tabId) || null
  const directives = computeCongestionDirectivesForTab(tabId)
  const adjusted = Math.min(
    Math.max(1, Number(bufferAdjustedWindow) || 1),
    directives.prefetchRadius
  )
  if (tabState) {
    tabState.currentDynamicRadius = adjusted
    tabState.speculativeAllowed = directives.speculativeAllowed === true
  }
  return adjusted
}

function resolveCongestionGlobalCap(tabId) {
  const bufferCap =
    typeof ns.resolveBufferAdjustedGlobalCap === "function"
      ? ns.resolveBufferAdjustedGlobalCap(tabId)
      : Math.max(1, Number(constants.GLOBAL_MAX_INFLIGHT_PREFETCHES) || 12)

  const tabState = state.playlistByTab.get(tabId)
  const directives =
    tabState?.congestionDirectives || computeCongestionDirectivesForTab(tabId)

  return Math.min(Math.max(1, bufferCap), Math.max(1, directives.maxInflight))
}

function formatCongestionTelemetryLine(tabId) {
  const tabState = state.playlistByTab.get(tabId)
  const directives =
    tabState?.congestionDirectives ||
    computeCongestionDirectivesForTab(tabId)
  const speculative = directives.speculativeAllowed ? "ON" : "OFF"
  return `congestion(radius=${directives.prefetchRadius}, inflightCap=${directives.maxInflight}, ttfb_p95=${directives.ttfbP95Ms || 0}ms, speculative=${speculative}, tier=${directives.activeTierName})`
}

function formatCongestionTelemetryLineGlobal() {
  const tabId = state.activePrefetchTabId
  if (Number.isFinite(tabId)) {
    return formatCongestionTelemetryLine(tabId)
  }
  const directives = computeCongestionDirectives(
    state.stats,
    null,
    Math.max(1, Number(state.settings.prefetchWindow) || 8)
  )
  const speculative = directives.speculativeAllowed ? "ON" : "OFF"
  return `congestion(radius=${directives.prefetchRadius}, inflightCap=${directives.maxInflight}, ttfb_p95=${directives.ttfbP95Ms || 0}ms, speculative=${speculative}, tier=${directives.activeTierName})`
}

ns.computeCongestionDirectives = computeCongestionDirectives
ns.computeCongestionDirectivesForTab = computeCongestionDirectivesForTab
ns.applyCongestionPrefetchRadius = applyCongestionPrefetchRadius
ns.resolveCongestionGlobalCap = resolveCongestionGlobalCap
ns.formatCongestionTelemetryLine = formatCongestionTelemetryLine
ns.formatCongestionTelemetryLineGlobal = formatCongestionTelemetryLineGlobal
ns.isScrubGuardActive = isScrubGuardActive
})()
