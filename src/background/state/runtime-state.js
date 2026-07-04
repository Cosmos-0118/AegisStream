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
    transitionWarmupByTab: new Map(),
    cachePolicy: createInitialCachePolicy(settings),
    telemetry: {
      firstByteAll: [],
      firstByteCache: [],
      firstByteNetwork: [],
      umpHashes: new Set(),
      logThrottleByKey: new Map(),
      lastUmpHealthLogAt: 0,
      extensionFetchBySource: {},
      chunkStore: {
        successfulStores: 0,
        failedStores: 0,
        totalBytesStored: 0,
        bySource: {}
      }
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
    speculativeAdaptiveMode: "full",
    adaptivePrefetch: {
      enabled: true,
      hitRateEma: 0.5,
      missRateEma: 0.5,
      lastAdjustedAt: 0,
      lastWindowBoost: 0,
      lastRunwayBoost: 0
    }
  }
}

function setTransitionWarmup(tabId, stateName, ttlMs) {
  if (!Number.isFinite(tabId)) return
  const expiresAt = Date.now() + Math.max(0, Number(ttlMs) || 0)
  if (expiresAt <= Date.now()) {
    state.transitionWarmupByTab.delete(tabId)
    return
  }
  state.transitionWarmupByTab.set(tabId, { stateName, expiresAt })
}

function getTransitionWarmup(tabId) {
  const entry = state.transitionWarmupByTab.get(tabId)
  if (!entry) return null
  if (Date.now() > Number(entry.expiresAt || 0)) {
    state.transitionWarmupByTab.delete(tabId)
    return null
  }
  return entry
}

function clearTransitionWarmup(tabId) {
  if (!Number.isFinite(tabId)) return
  state.transitionWarmupByTab.delete(tabId)
}

function isTabInTransitionWarmup(tabId) {
  return Boolean(getTransitionWarmup(tabId))
}

function getTransitionWarmupState(tabId) {
  return getTransitionWarmup(tabId)?.stateName || null
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

// ── Warm Recovery: Tab State Snapshot Persistence ──────────────────────
// On SW restart (update/idle kill), in-memory tab state is lost.
// We periodically persist a lightweight snapshot to chrome.storage.session
// so that on re-activation we can:
//  1. Restore the highest-quality activeRungLabel (prevents 360p lock)
//  2. Restore anchorIndex (prevents guard-ring misses)
//  3. Know the last known URL to re-associate tabs
const WARM_RECOVERY_STORAGE_KEY = "aegisWarmRecoveryTabState"
let warmRecoveryPersistTimer = null

function buildWarmRecoverySnapshot() {
  const entries = []
  for (const [tabId, tabState] of state.playlistByTab.entries()) {
    if (!tabState?.segments?.length && !tabState?.activeRungLabel) continue
    const snapshot = {
      tabId,
      activeRungLabel: tabState.activeRungLabel || null,
      anchorIndex: typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : null,
      hasAnchor: Boolean(tabState.hasAnchor),
      rungLabels: tabState.rungLabels ? [...tabState.rungLabels] : [],
      mediaPlaylistUrl: tabState.mediaPlaylistUrl || null,
      lastMediaPlaylistUrl:
        tabState.mediaPlaylistUrl || tabState.lastMediaPlaylistUrl || null,
      lastSegmentCount: tabState.segments?.length || 0,
      updatedAt: tabState.updatedAt || Date.now()
    }
    entries.push(snapshot)
    if (entries.length >= (constants.STATE_PERSIST_MAX_TABS || 8)) break
  }
  return {
    entries,
    stats: state.stats,
    persistedAt: Date.now(),
    workerStartCount: state.workerLifecycle?.startCount || 0
  }
}

function scheduleWarmRecoveryPersist() {
  const debounceMs = Number(constants.STATE_PERSIST_DEBOUNCE_MS) || 2000
  if (warmRecoveryPersistTimer) clearTimeout(warmRecoveryPersistTimer)
  warmRecoveryPersistTimer = setTimeout(() => {
    warmRecoveryPersistTimer = null
    void flushWarmRecoveryPersist()
  }, debounceMs)
}

async function flushWarmRecoveryPersist() {
  try {
    const snapshot = buildWarmRecoverySnapshot()
    if (!snapshot.entries.length) return
    await chrome.storage.session.set({ [WARM_RECOVERY_STORAGE_KEY]: snapshot })
  } catch {
    // Storage may not be available (incognito, quota, etc.)
  }
}

async function loadWarmRecoverySnapshot() {
  try {
    const stored = await chrome.storage.session.get([WARM_RECOVERY_STORAGE_KEY])
    const snapshot = stored[WARM_RECOVERY_STORAGE_KEY]
    if (!snapshot?.entries?.length) return null
    // Ignore snapshots written by the current worker — only restore from a prior lifecycle.
    if (snapshot.workerStartCount === state.workerLifecycle?.startCount) {
      return null
    }
    return snapshot
  } catch {
    return null
  }
}

function applyWarmRecoverySnapshot(snapshot) {
  if (snapshot?.stats) {
    state.stats = { ...constants.createInitialStats(), ...snapshot.stats }
  }

  if (!snapshot?.entries?.length) return 0
  let applied = 0
  for (const entry of snapshot.entries) {
    if (!Number.isFinite(entry.tabId) || entry.tabId < 0) continue
    const existing = state.playlistByTab.get(entry.tabId)
    // Keep fully established tab state; merge into partial state created before recovery ran.
    if (existing?.segments?.length) continue

    const playlistUrl =
      entry.mediaPlaylistUrl ||
      entry.lastMediaPlaylistUrl ||
      existing?.mediaPlaylistUrl ||
      null
    const tabState = {
      ...(existing || {}),
      segments: [],
      activeRungLabel: entry.activeRungLabel || null,
      anchorIndex: typeof entry.anchorIndex === "number" ? entry.anchorIndex : null,
      hasAnchor: Boolean(entry.hasAnchor && typeof entry.anchorIndex === "number"),
      rungLabels: Array.isArray(entry.rungLabels) ? entry.rungLabels : [],
      mediaPlaylistUrl: playlistUrl,
      lastMediaPlaylistUrl: playlistUrl,
      playlistRecaptureRequired: !(Number(entry.lastSegmentCount) > 0),
      warmRecovery: true,
      warmRecoveryAppliedAt: Date.now(),
      updatedAt: entry.updatedAt || Date.now()
    }
    state.playlistByTab.set(entry.tabId, tabState)
    applied += 1
  }
  if (applied > 0) {
    addLog("INFO", `Warm recovery: restored state for ${applied} tab(s) from snapshot`)
    const deferMs = Number(constants.WARM_RECOVERY_DEFER_PREFETCH_MS) || 3_000
    for (const entry of snapshot.entries) {
      if (!Number.isFinite(entry.tabId) || entry.tabId < 0) continue
      const tabId = entry.tabId
      setTimeout(() => {
        if (typeof ns.ensureTabPlaylistRecovery === "function") {
          void ns.ensureTabPlaylistRecovery(tabId, "warm-recovery", { force: true })
        }
      }, deferMs)
    }
  }
  return applied
}

/** After restart, defer quality-rung confirmation to avoid 360p lock. */
function isTabInWarmRecoveryRungConfirm(tabState) {
  if (!tabState?.warmRecovery) return false
  const appliedAt = Number(tabState.warmRecoveryAppliedAt || 0)
  return Date.now() - appliedAt < (constants.WARM_RECOVERY_RUNG_CONFIRM_MS || 10_000)
}

/** After restart, defer prefetch until state stabilizes. */
function isTabInWarmRecoveryDeferPrefetch() {
  if (state.workerLifecycle?.startCount < 2) return false
  const startedAt = Number(state.workerLifecycle?.lastStartedAt || 0)
  if (!startedAt) return false
  return Date.now() - startedAt < (constants.WARM_RECOVERY_DEFER_PREFETCH_MS || 3_000)
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
  state.telemetry.chunkStore = {
    successfulStores: 0,
    failedStores: 0,
    totalBytesStored: 0,
    bySource: {}
  }
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
ns.scheduleWarmRecoveryPersist = scheduleWarmRecoveryPersist
ns.loadWarmRecoverySnapshot = loadWarmRecoverySnapshot
ns.applyWarmRecoverySnapshot = applyWarmRecoverySnapshot
ns.isTabInWarmRecoveryRungConfirm = isTabInWarmRecoveryRungConfirm
ns.isTabInWarmRecoveryDeferPrefetch = isTabInWarmRecoveryDeferPrefetch
ns.setTransitionWarmup = setTransitionWarmup
ns.getTransitionWarmup = getTransitionWarmup
ns.clearTransitionWarmup = clearTransitionWarmup
ns.isTabInTransitionWarmup = isTabInTransitionWarmup
ns.getTransitionWarmupState = getTransitionWarmupState
})()
