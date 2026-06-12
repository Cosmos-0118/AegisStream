(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

function createNetworkPanicState() {
  return {
    active: false,
    activatedAt: 0,
    clearedAt: 0,
    networkP95Ms: 0,
    prefetchWindow: constants.PANIC_PREFETCH_WINDOW || 20,
    targetRunwaySec: constants.PANIC_TARGET_RUNWAY_SEC || 180
  }
}

function getNetworkP95Ms() {
  const network = state.telemetry?.firstByteNetwork
  if (!Array.isArray(network) || network.length === 0) return 0
  const sorted = [...network].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(0.95 * (sorted.length - 1)))
  )
  return Math.round(sorted[idx])
}

function isNetworkPanicActive() {
  return state.networkPanic?.active === true
}

function buildSettingsPayloadForTabs() {
  const base = state.settings ? { ...state.settings } : {}
  const panic = isNetworkPanicActive()
  const adaptive =
    typeof ns.getAdaptiveLimits === "function" ? ns.getAdaptiveLimits() : null
  return {
    ...base,
    networkPanicActive: panic,
    bufferTargetRunwaySec: panic
      ? constants.PANIC_TARGET_RUNWAY_SEC
      : constants.BUFFER_TARGET_RUNWAY_SEC,
    networkFirstByteP95Ms: Number(state.stats?.networkFirstByteP95Ms) || 0,
    speculativeAdaptiveMode: adaptive?.mode || state.speculativeAdaptiveMode || "full",
    crossItagAllowed: false
  }
}

function syncNetworkPanicMode(options = {}) {
  if (!state.networkPanic) {
    state.networkPanic = createNetworkPanicState()
  }

  const network = state.telemetry?.firstByteNetwork || []
  const sampleCount = network.length
  const networkP95 = getNetworkP95Ms()
  state.stats.networkFirstByteP95Ms = networkP95

  const minSamples = Math.max(4, Number(constants.TTFB_PANIC_MIN_NETWORK_SAMPLES) || 12)
  const enterAt = Number(constants.TTFB_PANIC_ENTER_P95_MS) || 3000
  const exitAt = Number(constants.TTFB_PANIC_EXIT_P95_MS) || 2400
  const wasActive = state.networkPanic.active === true

  let shouldActivate = wasActive
  if (sampleCount >= minSamples) {
    shouldActivate = wasActive ? networkP95 >= exitAt : networkP95 >= enterAt
  } else if (!wasActive) {
    shouldActivate = false
  }

  state.networkPanic.networkP95Ms = networkP95
  state.networkPanic.prefetchWindow = constants.PANIC_PREFETCH_WINDOW
  state.networkPanic.targetRunwaySec = constants.PANIC_TARGET_RUNWAY_SEC

  if (shouldActivate === wasActive) {
    state.stats.networkPanicActive = wasActive ? 1 : 0
    return wasActive
  }

  const now = Date.now()
  state.networkPanic.active = shouldActivate
  state.stats.networkPanicActive = shouldActivate ? 1 : 0

  if (shouldActivate) {
    state.networkPanic.activatedAt = now
    state.networkPanic.clearedAt = 0
    addLog(
      "WARN",
      `Network panic mode ON — network ttfb_p95=${networkP95}ms (>=${enterAt}ms): prefetch=${constants.PANIC_PREFETCH_WINDOW}, target runway=${constants.PANIC_TARGET_RUNWAY_SEC}s`
    )
  } else {
    state.networkPanic.clearedAt = now
    addLog(
      "INFO",
      `Network panic mode OFF — network ttfb_p95=${networkP95}ms (<${exitAt}ms clear threshold)`
    )
  }

  if (typeof ns.broadcastSettingsToTabs === "function") {
    void ns.broadcastSettingsToTabs(buildSettingsPayloadForTabs())
  }

  return shouldActivate
}

function resolvePanicAdjustedPrefetchWindow(baseWindow) {
  if (!isNetworkPanicActive()) return baseWindow
  return Math.max(
    baseWindow,
    Math.max(1, Number(constants.PANIC_PREFETCH_WINDOW) || 20)
  )
}

function resolvePanicAdjustedGlobalCap(baseCap) {
  if (!isNetworkPanicActive()) return baseCap
  return Math.min(24, Math.max(baseCap, baseCap + 6))
}

ns.createNetworkPanicState = createNetworkPanicState
ns.getNetworkP95Ms = getNetworkP95Ms
ns.isNetworkPanicActive = isNetworkPanicActive
ns.buildSettingsPayloadForTabs = buildSettingsPayloadForTabs
ns.syncNetworkPanicMode = syncNetworkPanicMode
ns.resolvePanicAdjustedPrefetchWindow = resolvePanicAdjustedPrefetchWindow
ns.resolvePanicAdjustedGlobalCap = resolvePanicAdjustedGlobalCap
})()
