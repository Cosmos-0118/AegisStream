(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog, stripHash, buildCacheKeyVariants } = ns

const REGISTRY_MAX_ENTRIES = 800
const REGISTRY_TTL_MS = 12 * 60 * 1000
const PRUNE_INTERVAL_MS = 45_000
const HEALTH_LOG_INTERVAL_MS = 60_000

/** @type {Map<string, object>} */
const registryByUrl = new Map()
let lastPruneAt = 0
let lastHealthLogAt = 0

function normalizeRegistryKey(url) {
  return stripHash(url) || (typeof url === "string" ? url : null)
}

function registerUrlKeys(entry, url) {
  const keys = new Set()
  const primary = normalizeRegistryKey(url)
  if (primary) keys.add(primary)
  for (const variant of buildCacheKeyVariants(url)) {
    keys.add(variant)
  }
  for (const key of keys) {
    if (registryByUrl.size >= REGISTRY_MAX_ENTRIES && !registryByUrl.has(key)) {
      pruneExpiredEntries(true)
    }
    registryByUrl.set(key, entry)
  }
  entry.lookupKeys = keys
}

function bumpStat(name, amount = 1) {
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity(name, amount)
    return
  }
  if (typeof state.stats[name] !== "number") state.stats[name] = 0
  state.stats[name] += amount
}

function getBytesHitRatePercent() {
  const downloaded = Number(state.stats.speculativeBytesDownloaded) || 0
  const consumed = Number(state.stats.speculativeBytesConsumed) || 0
  if (downloaded <= 0) return null
  return Math.round((consumed / downloaded) * 1000) / 10
}

function getCountHitRatePercent() {
  const completed = Number(state.stats.speculativePrefetchCompleted) || 0
  const used = Number(state.stats.speculativePrefetchUsed) || 0
  if (completed <= 0) return null
  return Math.round((used / completed) * 1000) / 10
}

function computeAdaptiveMode() {
  const completed = Number(state.stats.speculativePrefetchCompleted) || 0
  const minSamples = Number(constants.SPECULATIVE_MIN_SAMPLES_FOR_ADAPTIVE) || 20
  if (completed < minSamples) return "full"

  const bytesRate = getBytesHitRatePercent()
  const countRate = getCountHitRatePercent()
  const hitRate =
    bytesRate != null && countRate != null
      ? Math.min(bytesRate, countRate)
      : bytesRate ?? countRate ?? 100

  const disablePct = Number(constants.SPECULATIVE_HIT_RATE_DISABLE_PCT) || 5
  const fullPct = Number(constants.SPECULATIVE_HIT_RATE_FULL_PCT) || 40

  if (hitRate < disablePct) return "minimal"
  if (hitRate < fullPct) return "reduced"
  return "full"
}

function isSpeculativeEnabledInSettings() {
  return state.settings.speculativePrefetchEnabled !== false
}

function getAdaptiveLimits() {
  if (!isSpeculativeEnabledInSettings()) {
    return { mode: "off", segmentsAhead: 0, maxUrls: 0, crossItag: false }
  }

  const mode = computeAdaptiveMode()
  state.speculativeAdaptiveMode = mode

  if (mode === "minimal") {
    return {
      mode,
      segmentsAhead: 1,
      maxUrls: Math.min(2, Number(constants.SPECULATIVE_MAX_URLS_PER_CYCLE) || 10),
      crossItag: false
    }
  }
  if (mode === "reduced") {
    return {
      mode,
      segmentsAhead: Math.max(1, Math.floor((constants.SPECULATIVE_SEGMENTS_AHEAD || 2) / 2)),
      maxUrls: Math.max(2, Math.floor((constants.SPECULATIVE_MAX_URLS_PER_CYCLE || 10) / 2)),
      crossItag: true
    }
  }
  return {
    mode: "full",
    segmentsAhead: Number(constants.SPECULATIVE_SEGMENTS_AHEAD) || 2,
    maxUrls: Number(constants.SPECULATIVE_MAX_URLS_PER_CYCLE) || 10,
    crossItag: true
  }
}

function isSpeculativePrefetchAllowed() {
  return isSpeculativeEnabledInSettings() && getAdaptiveLimits().mode !== "off"
}

function shouldAllowCrossItagSpeculative() {
  return isSpeculativePrefetchAllowed() && getAdaptiveLimits().crossItag
}

function registerSpeculativePrefetch(meta = {}) {
  if (!isSpeculativePrefetchAllowed()) return null
  const url = meta.url
  if (!url) return null

  pruneExpiredEntries(false)

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    primaryUrl: normalizeRegistryKey(url),
    tabId: Number.isFinite(meta.tabId) ? meta.tabId : null,
    source: meta.source || "speculative-rung",
    fromRung: meta.fromRung || null,
    toRung: meta.toRung || null,
    fromItag: meta.fromItag || null,
    toItag: meta.toItag || null,
    startedAt: Date.now(),
    completedAt: 0,
    usedAt: 0,
    bytesDownloaded: 0,
    bytesConsumed: 0,
    status: "started"
  }

  registerUrlKeys(entry, url)
  bumpStat("speculativePrefetchStarted", 1)
  return entry.id
}

function findRegistryEntry(url) {
  const key = normalizeRegistryKey(url)
  if (!key) return null
  const direct = registryByUrl.get(key)
  if (direct) return direct
  for (const variant of buildCacheKeyVariants(url)) {
    const hit = registryByUrl.get(variant)
    if (hit) return hit
  }
  return null
}

function recordSpeculativeCompleted(url, bytes = 0, success = true) {
  const entry = findRegistryEntry(url)
  if (!entry || entry.status !== "started") return false

  if (!success) {
    entry.status = "wasted"
    bumpStat("speculativePrefetchWasted", 1)
    return false
  }

  entry.status = "completed"
  entry.completedAt = Date.now()
  entry.bytesDownloaded = Math.max(0, Number(bytes) || 0)
  bumpStat("speculativePrefetchCompleted", 1)
  if (entry.bytesDownloaded > 0) {
    bumpStat("speculativeBytesDownloaded", entry.bytesDownloaded)
  }
  maybeLogSpeculativeHealth()
  return true
}

function recordSpeculativeUsed(url, bytes = 0, tabId = null) {
  const entry = findRegistryEntry(url)
  if (!entry) return false
  if (entry.status === "used") return false

  const now = Date.now()
  const byteLen = Math.max(0, Number(bytes) || entry.bytesDownloaded || 0)

  if (entry.status === "started") {
    entry.status = "completed"
    entry.completedAt = now
    entry.bytesDownloaded = byteLen
    bumpStat("speculativePrefetchCompleted", 1)
    if (byteLen > 0) bumpStat("speculativeBytesDownloaded", byteLen)
  }

  entry.status = "used"
  entry.usedAt = now
  entry.bytesConsumed = byteLen
  bumpStat("speculativePrefetchUsed", 1)
  if (byteLen > 0) bumpStat("speculativeBytesConsumed", byteLen)

  const resolvedTabId = tabId ?? entry.tabId
  if (Number.isFinite(resolvedTabId)) {
    const tabState = state.playlistByTab.get(resolvedTabId)
    const switchAt = Number(tabState?.lastQualitySwitchAt || 0)
    if (switchAt > 0 && now - switchAt < 12_000) {
      const switchedRung =
        entry.toRung &&
        tabState?.activeRungLabel &&
        entry.toRung === tabState.activeRungLabel &&
        entry.fromRung !== entry.toRung
      if (switchedRung) {
        bumpStat("speculativeQualitySwitchHits", 1)
        addLog(
          "INFO",
          `Speculative HLS quality-switch hit (${entry.fromRung}→${entry.toRung}, ${Math.round(byteLen / 1024)} KB)`
        )
      }
      if (entry.source === "cross-itag" && entry.toItag && entry.fromItag !== entry.toItag) {
        bumpStat("speculativeCrossItagUsed", 1)
        bumpStat("speculativeQualitySwitchHits", 1)
        addLog(
          "INFO",
          `Speculative YouTube cross-itag consumed (itag ${entry.fromItag}→${entry.toItag}, ${Math.round(byteLen / 1024)} KB)`
        )
      }
    }
  }

  maybeLogSpeculativeHealth()

  if (Number.isFinite(resolvedTabId) && typeof ns.tryResolveSpeculationAtSegment === "function") {
    const tabState = state.playlistByTab.get(resolvedTabId)
    let segmentIndex = null
    if (tabState && typeof ns.resolveSegmentIndexInManifest === "function") {
      segmentIndex = ns.resolveSegmentIndexInManifest(url, tabState)
    }
    if (typeof segmentIndex === "number") {
      ns.tryResolveSpeculationAtSegment(resolvedTabId, segmentIndex, {
        was_hit: true,
        resolve_source: "cache-hit",
        bitrate_tier_used: entry.toRung || tabState?.activeRungLabel || null
      })
    }
  }

  return true
}

function pruneExpiredEntries(force = false) {
  const now = Date.now()
  if (!force && now - lastPruneAt < PRUNE_INTERVAL_MS) return
  lastPruneAt = now

  const seen = new Set()
  for (const [key, entry] of registryByUrl.entries()) {
    if (seen.has(entry.id)) {
      registryByUrl.delete(key)
      continue
    }
    seen.add(entry.id)

    const age = now - Number(entry.startedAt || 0)
    if (age < REGISTRY_TTL_MS) continue

    if (entry.status === "started") {
      entry.status = "expired"
      bumpStat("speculativePrefetchExpired", 1)
    } else if (entry.status === "completed") {
      entry.status = "wasted"
      bumpStat("speculativePrefetchWasted", 1)
      if (entry.bytesDownloaded > 0) {
        bumpStat("speculativeBytesWasted", entry.bytesDownloaded)
      }
    }

    for (const lookupKey of entry.lookupKeys || []) {
      registryByUrl.delete(lookupKey)
    }
  }
}

function maybeLogSpeculativeHealth(force = false) {
  const now = Date.now()
  if (!force && now - lastHealthLogAt < HEALTH_LOG_INTERVAL_MS) return
  const completed = Number(state.stats.speculativePrefetchCompleted) || 0
  if (completed < 5) return
  lastHealthLogAt = now

  const bytesRate = getBytesHitRatePercent()
  const countRate = getCountHitRatePercent()
  const mode = computeAdaptiveMode()
  const downloadedMb = ((Number(state.stats.speculativeBytesDownloaded) || 0) / (1024 * 1024)).toFixed(2)
  const consumedMb = ((Number(state.stats.speculativeBytesConsumed) || 0) / (1024 * 1024)).toFixed(2)

  addLog(
    "INFO",
    `Speculative telemetry: mode=${mode}, hit=${bytesRate ?? "?"}% bytes / ${countRate ?? "?"}% count, downloaded=${downloadedMb} MB, consumed=${consumedMb} MB, used=${state.stats.speculativePrefetchUsed || 0}/${completed}, wasted=${state.stats.speculativePrefetchWasted || 0}, switch-hits=${state.stats.speculativeQualitySwitchHits || 0}`
  )
}

function resetSpeculativeTelemetry() {
  registryByUrl.clear()
  lastPruneAt = 0
  lastHealthLogAt = 0
  state.speculativeAdaptiveMode = "full"
  const keys = [
    "speculativePrefetchStarted",
    "speculativePrefetchCompleted",
    "speculativePrefetchUsed",
    "speculativePrefetchWasted",
    "speculativePrefetchExpired",
    "speculativeBytesDownloaded",
    "speculativeBytesConsumed",
    "speculativeBytesWasted",
    "speculativeQualitySwitchHits",
    "speculativeCrossItagUsed",
    "speculativeMatrixBuilt",
    "speculativePrefetchScheduled"
  ]
  for (const key of keys) {
    if (typeof state.stats[key] === "number") state.stats[key] = 0
  }
}

function getSpeculativeTelemetrySummary() {
  pruneExpiredEntries(false)
  const mode = computeAdaptiveMode()
  return {
    adaptiveMode: mode,
    bytesHitRatePercent: getBytesHitRatePercent(),
    countHitRatePercent: getCountHitRatePercent(),
    started: Number(state.stats.speculativePrefetchStarted) || 0,
    completed: Number(state.stats.speculativePrefetchCompleted) || 0,
    used: Number(state.stats.speculativePrefetchUsed) || 0,
    wasted: Number(state.stats.speculativePrefetchWasted) || 0,
    expired: Number(state.stats.speculativePrefetchExpired) || 0,
    bytesDownloaded: Number(state.stats.speculativeBytesDownloaded) || 0,
    bytesConsumed: Number(state.stats.speculativeBytesConsumed) || 0,
    bytesWasted: Number(state.stats.speculativeBytesWasted) || 0,
    qualitySwitchHits: Number(state.stats.speculativeQualitySwitchHits) || 0,
    crossItagUsed: Number(state.stats.speculativeCrossItagUsed) || 0,
    limits: getAdaptiveLimits()
  }
}

ns.registerSpeculativePrefetch = registerSpeculativePrefetch
ns.recordSpeculativeCompleted = recordSpeculativeCompleted
ns.recordSpeculativeUsed = recordSpeculativeUsed
ns.isSpeculativePrefetchAllowed = isSpeculativePrefetchAllowed
ns.shouldAllowCrossItagSpeculative = shouldAllowCrossItagSpeculative
ns.getAdaptiveLimits = getAdaptiveLimits
ns.getSpeculativeTelemetrySummary = getSpeculativeTelemetrySummary
ns.resetSpeculativeTelemetry = resetSpeculativeTelemetry
ns.maybeLogSpeculativeHealth = maybeLogSpeculativeHealth
})()
