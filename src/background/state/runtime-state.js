(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

function createInitialCachePolicy(settings) {
  const maxEntries = Math.max(50, Number(settings?.maxEntries) || constants.DEFAULT_SETTINGS.maxEntries)
  const maxBytes = Math.max(constants.CACHE_MIN_BYTES, constants.CACHE_DEFAULT_AVG_CHUNK_BYTES * maxEntries)
  return {
    maxEntries,
    maxBytes,
    avgChunkBytes: constants.CACHE_DEFAULT_AVG_CHUNK_BYTES,
    lastComputedAt: 0
  }
}

function createState() {
  const settings = { ...constants.DEFAULT_SETTINGS }
  return {
    settings,
    playlistByTab: new Map(),
    pendingPrefetchByTab: new Map(),
    tabAnchorJumps: new Map(),
    inflightPrefetches: new Map(),
    failedPrefetches: new Map(),
    bridgeHeartbeatByTab: new Map(),
    umpLookupSeenAt: new Map(),
    cachePolicy: createInitialCachePolicy(settings),
    telemetry: {
      firstByteAll: [],
      firstByteCache: [],
      firstByteNetwork: [],
      umpHashes: new Set(),
      logThrottleByKey: new Map(),
      lastUmpHealthLogAt: 0,
      extensionFetchBySource: {}
    },
    workerLifecycle: {
      startCount: 0,
      lastStartedAt: 0,
      lastReason: null
    },
    networkPanic: {
      active: false,
      activatedAt: 0,
      clearedAt: 0,
      networkP95Ms: 0,
      prefetchWindow: 20,
      targetRunwaySec: 180
    },
    logs: [],
    stats: constants.createInitialStats(),
    activePrefetchTabId: null,
    tabPageHostByTab: new Map(),
    tabPageUrlFingerprintByTab: new Map(),
    twitchSessionByTab: new Map(),
    speculativeAdaptiveMode: "full"
  }
}

const state = createState()

function addLog(level, message) {
  const ts = new Date().toISOString()
  state.logs.push({ timestamp: ts, level, message })
  if (state.logs.length > constants.MAX_LOG_ENTRIES) {
    state.logs = state.logs.slice(-constants.MAX_LOG_ENTRIES)
  }
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function sanitizeSettings(candidate = {}) {
  const sanitized = {
    enabled: candidate.enabled !== false,
    prefetchEnabled: candidate.prefetchEnabled !== false,
    serveFromCache: candidate.serveFromCache !== false,
    maxEntries: clampNumber(
      candidate.maxEntries,
      50,
      5000,
      constants.DEFAULT_SETTINGS.maxEntries
    ),
    prefetchWindow: clampNumber(
      candidate.prefetchWindow,
      1,
      20,
      constants.DEFAULT_SETTINGS.prefetchWindow
    ),
    documentStreamBoost: candidate.documentStreamBoost !== false,
    headerEarlyHints: candidate.headerEarlyHints !== false,
    cpuShieldEnabled: candidate.cpuShieldEnabled !== false,
    aggressiveScriptDefuserEnabled: candidate.aggressiveScriptDefuserEnabled === true,
    bfcacheEnforcerEnabled: candidate.bfcacheEnforcerEnabled !== false,
    speculativePrefetchEnabled: candidate.speculativePrefetchEnabled !== false
  }
  state.cachePolicy.maxEntries = sanitized.maxEntries
  if (!Number.isFinite(state.cachePolicy.maxBytes) || state.cachePolicy.maxBytes < constants.CACHE_MIN_BYTES) {
    state.cachePolicy.maxBytes = Math.max(
      constants.CACHE_MIN_BYTES,
      constants.CACHE_DEFAULT_AVG_CHUNK_BYTES * sanitized.maxEntries
    )
  }
  return sanitized
}

function resetStats() {
  state.stats = constants.createInitialStats()
  state.telemetry.firstByteAll = []
  state.telemetry.firstByteCache = []
  state.telemetry.firstByteNetwork = []
  state.telemetry.umpHashes.clear()
  state.telemetry.logThrottleByKey.clear()
  state.telemetry.lastUmpHealthLogAt = 0
  if (typeof ns.resetActivityMetrics === "function") {
    ns.resetActivityMetrics()
  }
  if (typeof ns.resetSpeculativeTelemetry === "function") {
    ns.resetSpeculativeTelemetry()
  }
  if (typeof ns.resetExtensionFetchMetrics === "function") {
    ns.resetExtensionFetchMetrics()
  }
  if (typeof ns.resetSeekPredictionTelemetry === "function") {
    ns.resetSeekPredictionTelemetry()
  }
}

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get("settings")
    state.settings = sanitizeSettings({
      ...constants.DEFAULT_SETTINGS,
      ...(stored.settings || {})
    })
    addLog("INFO", "Settings loaded successfully")
  } catch (e) {
    addLog("ERROR", `Failed to load settings: ${e.message}`)
  }
}

ns.state = state
ns.addLog = addLog
ns.sanitizeSettings = sanitizeSettings
ns.resetStats = resetStats
ns.loadSettings = loadSettings
})()
