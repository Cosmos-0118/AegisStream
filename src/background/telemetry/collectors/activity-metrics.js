(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state } = ns

const WINDOW_MS = 5 * 60 * 1000
const BUCKET_MS = 15_000
const CACHE_COUNT_REFRESH_MS = 2500

let buckets = []
let cacheCountSnapshot = 0
let cacheCountFetchedAt = 0
const recentLookupMetricAt = new Map()
const LOOKUP_METRIC_DEDUPE_MS = 2_000

function bucketStartMs(now = Date.now()) {
  return Math.floor(now / BUCKET_MS) * BUCKET_MS
}

function pruneBuckets(now = Date.now()) {
  const cutoff = now - WINDOW_MS
  if (buckets.length === 0) return
  buckets = buckets.filter((bucket) => bucket.t >= cutoff)
}

function getOrCreateBucket(now = Date.now()) {
  const start = bucketStartMs(now)
  let bucket = buckets.find((entry) => entry.t === start)
  if (!bucket) {
    bucket = { t: start, c: {} }
    buckets.push(bucket)
  }
  return bucket
}

function bumpActivity(metric, amount = 1) {
  if (!Number.isFinite(amount) || amount === 0) return
  pruneBuckets()
  const bucket = getOrCreateBucket()
  bucket.c[metric] = (bucket.c[metric] || 0) + amount
  if (typeof state.stats[metric] === "number") {
    state.stats[metric] += amount
  }
}

function pruneLookupMetricDedupe(now = Date.now()) {
  if (recentLookupMetricAt.size === 0) return
  const cutoff = now - LOOKUP_METRIC_DEDUPE_MS * 4
  for (const [key, ts] of recentLookupMetricAt.entries()) {
    if (ts < cutoff) recentLookupMetricAt.delete(key)
  }
}

function shouldSkipLookupMetricDedupe(metric, url) {
  if (!url || typeof url !== "string") return false
  pruneLookupMetricDedupe()
  const key = `${metric}:${url}`
  const now = Date.now()
  const last = recentLookupMetricAt.get(key) || 0
  if (now - last < LOOKUP_METRIC_DEDUPE_MS) return true
  recentLookupMetricAt.set(key, now)
  return false
}

function bumpLookupMetric(metric, url, amount = 1) {
  if (shouldSkipLookupMetricDedupe(metric, url)) return
  bumpActivity(metric, amount)
}

/** Always count player-facing cache serves (no per-URL dedupe). */
function recordCacheServeHit(url) {
  if (typeof ns.recordStreamMetric === "function") {
    ns.recordStreamMetric("hls", "hits", 1)
  }
  bumpActivity("cacheHits", 1)
  bumpActivity("cacheLookups", 1)
  if (url && typeof url === "string") {
    pruneLookupMetricDedupe()
    recentLookupMetricAt.set(`cacheHits:${url}`, Date.now())
  }
}

function recordCacheLookupMiss(url) {
  if (typeof ns.recordStreamMetric === "function") {
    ns.recordStreamMetric("hls", "misses", 1)
  }
  bumpLookupMetric("cacheMisses", url, 1)
  if (typeof ns.noteRecentlyEvictedMiss === "function") {
    ns.noteRecentlyEvictedMiss(url)
  }
  if (typeof ns.notePainCacheMiss === "function") {
    ns.notePainCacheMiss(1)
  }
}

function resetActivityMetrics() {
  buckets = []
  cacheCountSnapshot = 0
  cacheCountFetchedAt = 0
  recentLookupMetricAt.clear()
  if (typeof ns.resetMetricsCollector === "function") {
    ns.resetMetricsCollector()
  }
  if (typeof ns.resetSeekPredictionTelemetry === "function") {
    ns.resetSeekPredictionTelemetry()
  }
  if (typeof ns.resetAnchorTelemetry === "function") {
    ns.resetAnchorTelemetry()
  }
  if (typeof ns.resetDecisionObservability === "function") {
    ns.resetDecisionObservability()
  }
  if (typeof ns.resetEvictionJournal === "function") {
    ns.resetEvictionJournal()
  }
  if (state?.manifestIndexQualityByTab instanceof Map) {
    state.manifestIndexQualityByTab.clear()
  }
  if (state?.lookupMappingCoverageByTab instanceof Map) {
    state.lookupMappingCoverageByTab.clear()
  }
}

function sumWindowCounters() {
  pruneBuckets()
  const totals = {}
  for (const bucket of buckets) {
    for (const [metric, value] of Object.entries(bucket.c)) {
      totals[metric] = (totals[metric] || 0) + value
    }
  }
  return totals
}

async function refreshCacheEntryCount(force = false) {
  const now = Date.now()
  if (!force && now - cacheCountFetchedAt < CACHE_COUNT_REFRESH_MS) {
    return cacheCountSnapshot
  }
  cacheCountFetchedAt = now
  try {
    cacheCountSnapshot = await ns.getCacheEntryCount()
  } catch {
    cacheCountSnapshot = 0
  }
  return cacheCountSnapshot
}

function buildBufferHealthDisplaySummary(now = Date.now()) {
  const byTab = state?.playlistByTab
  if (!(byTab instanceof Map)) return null
  let latest = null
  let bestRunwaySec = null
  let activeTabs = 0
  let totalRunwaySec = 0

  for (const [tabId, tabState] of byTab.entries()) {
    const updatedAt = Number(tabState?.bufferUpdatedAt || 0)
    if (updatedAt <= 0 || now - updatedAt > constants.BUFFER_HEALTH_STALE_MS) continue
    const runwaySec = Number(tabState.bufferRunwaySec)
    if (!Number.isFinite(runwaySec)) continue
    activeTabs += 1
    totalRunwaySec += runwaySec
    bestRunwaySec = bestRunwaySec === null ? runwaySec : Math.max(bestRunwaySec, runwaySec)
    if (!latest || updatedAt > latest.updatedAt) {
      latest = {
        tabId,
        runwaySec,
        runwayPct: Number(tabState.bufferRunwayPct),
        healthScore: Number(tabState.bufferHealthScore),
        tier: tabState.bufferTier || null,
        netFillRate: Number(tabState.bufferNetFillRate),
        updatedAt
      }
    }
  }

  if (!latest) return null
  return {
    ...latest,
    activeTabs,
    bestRunwaySec,
    averageRunwaySec: activeTabs > 0 ? Math.round((totalRunwaySec / activeTabs) * 10) / 10 : null
  }
}

function buildChunkStoreDisplaySummary() {
  const totals = state?.telemetry?.chunkStore || {}
  const bySource = totals.bySource || {}
  const prefetch = bySource.prefetch || {}
  return {
    successfulStores: Number(totals.successfulStores || 0),
    failedStores: Number(totals.failedStores || 0),
    totalBytesStored: Number(totals.totalBytesStored || 0),
    prefetchStores: Number(prefetch.success || 0),
    prefetchBytes: Number(prefetch.bytes || 0),
    bySource
  }
}

async function buildDisplayStats() {
  const windowTotals = sumWindowCounters()
  const cacheEntries = await refreshCacheEntryCount()
  const streamSnapshot =
    typeof ns.metrics?.getSnapshot === "function" ? ns.metrics.getSnapshot() : null
  const hits = Math.max(
    windowTotals.cacheHits || 0,
    Number(state.stats.cacheHits) || 0,
    streamSnapshot?.hls?.hits || 0
  )
  const misses = Math.max(
    windowTotals.cacheMisses || 0,
    Number(state.stats.cacheMisses) || 0,
    streamSnapshot?.hls?.misses || 0
  )
  const warmups = windowTotals.cacheWarmups || 0
  const lookups = windowTotals.cacheLookups || 0
  const resolvedLookups = hits + misses + warmups
  const hitRateDenominator = hits + misses
  const hitRatePercent =
    hitRateDenominator > 0 ? Math.round((hits / hitRateDenominator) * 100) : 0
  const chunksStoredInWindow = windowTotals.cachedChunks || 0
  const cacheFillWrites = windowTotals.cacheFillWrites || 0
  const cacheFillBytes = windowTotals.cacheFillBytes || 0

  return {
    cacheHits: hits,
    cacheMisses: misses,
    cacheWarmups: warmups,
    cacheLookups: lookups > 0 ? lookups : resolvedLookups,
    cacheLookupSkipped: windowTotals.cacheLookupSkipped || 0,
    requestCollapseHits: windowTotals.requestCollapseHits || 0,
    evictionSuppressedByScrub: Math.max(
      windowTotals.evictionSuppressedByScrub || 0,
      Number(state.stats.evictionSuppressedByScrub) || 0
    ),
    consumerProtectedSkips: Math.max(
      windowTotals.consumerProtectedSkips || 0,
      Number(state.stats.consumerProtectedSkips) || 0
    ),
    collapseCancellations: Math.max(
      windowTotals.collapseCancellations || 0,
      Number(state.stats.collapseCancellations) || 0
    ),
    collapseFallbacks: Math.max(
      windowTotals.collapseFallbacks || 0,
      Number(state.stats.collapseFallbacks) || 0
    ),
    evictThenMiss:
      typeof ns.getEvictThenMissSummary === "function"
        ? ns.getEvictThenMissSummary()
        : null,
    manifestIndexQuality:
      typeof ns.getManifestIndexQualitySummary === "function"
        ? ns.getManifestIndexQualitySummary()
        : null,
    lookupMappingCoverage:
      typeof ns.getLookupMappingCoverageSummary === "function"
        ? ns.getLookupMappingCoverageSummary()
        : null,
    hitRatePercent,
    chunksStoredInWindow,
    cacheFillWrites,
    cacheFillBytes,
    prefetchFillWrites: windowTotals.prefetchFillWrites || 0,
    prefetchFillBytes: windowTotals.prefetchFillBytes || 0,
    chunkStore: buildChunkStoreDisplaySummary(),
    bufferHealth: buildBufferHealthDisplaySummary(),
    cacheEntries,
    cachedChunks: cacheEntries,
    prefetched: windowTotals.prefetched || 0,
    prefetchFailed: windowTotals.prefetchFailed || 0,
    playlistsDetected: windowTotals.playlistsDetected || 0,
    chunksObserved: windowTotals.chunksObserved || 0,
    videoStalls: windowTotals.videoStalls || 0,
    videoStallMsTotal: windowTotals.videoStallMsTotal || 0,
    videoStallLongestMs: state.stats.videoStallLongestMs || 0,
    requestFirstByteSamples: state.stats.requestFirstByteSamples || 0,
    requestFirstByteAvgMs: state.stats.requestFirstByteAvgMs || 0,
    requestFirstByteP95Ms: state.stats.requestFirstByteP95Ms || 0,
    networkFirstByteP95Ms: state.stats.networkFirstByteP95Ms || 0,
    networkPanicActive: state.stats.networkPanicActive === 1,
    cacheFirstByteAvgMs: state.stats.cacheFirstByteAvgMs || 0,
    networkFirstByteAvgMs: state.stats.networkFirstByteAvgMs || 0,
    extensionFetchStarted: state.stats.extensionFetchStarted || 0,
    extensionFetchCompleted: state.stats.extensionFetchCompleted || 0,
    extensionFetchAborted: state.stats.extensionFetchAborted || 0,
    extensionFetchFailed: state.stats.extensionFetchFailed || 0,
    playlistFingerprintNewPlayback:
      windowTotals.playlistFingerprintNewPlayback || state.stats.playlistFingerprintNewPlayback || 0,
    extensionFetchBySource: state.telemetry.extensionFetchBySource || {},
    workerStartCount:
      typeof ns.getWorkerLifecycleSnapshot === "function"
        ? ns.getWorkerLifecycleSnapshot().workerStartCount
        : Number(state.workerLifecycle?.startCount) || 0,
    workerLastStarted:
      typeof ns.getWorkerLifecycleSnapshot === "function"
        ? ns.getWorkerLifecycleSnapshot().workerLastStarted
        : Number(state.workerLifecycle?.lastStartedAt) || 0,
    workerRestartReason:
      typeof ns.getWorkerLifecycleSnapshot === "function"
        ? ns.getWorkerLifecycleSnapshot().workerRestartReason
        : state.workerLifecycle?.lastReason || null,
    activityWindowMs: WINDOW_MS,
    activityWindowLabel: "Last 5 min",
    speculative:
      typeof ns.getSpeculativeTelemetrySummary === "function"
        ? ns.getSpeculativeTelemetrySummary()
        : null,
    streamMetrics:
      typeof ns.metrics?.getSnapshot === "function" ? ns.metrics.getSnapshot() : null,
    seekPrediction:
      typeof ns.getSeekPredictionSummary === "function"
        ? ns.getSeekPredictionSummary()
        : null,
    anchorOwnership:
      typeof ns.getAnchorOwnershipSummary === "function"
        ? ns.getAnchorOwnershipSummary()
        : null
  }
}

ns.ACTIVITY_WINDOW_MS = WINDOW_MS
ns.bumpActivity = bumpActivity
ns.bumpLookupMetric = bumpLookupMetric
ns.recordCacheServeHit = recordCacheServeHit
ns.recordCacheLookupMiss = recordCacheLookupMiss
ns.resetActivityMetrics = resetActivityMetrics
ns.buildDisplayStats = buildDisplayStats
ns.refreshCacheEntryCount = refreshCacheEntryCount
ns.sumWindowCounters = sumWindowCounters
})()
