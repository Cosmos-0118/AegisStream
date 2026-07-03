(() => {
  var ns = (self.AegisBackground ||= {})
  const { addLog } = ns

  const ROLLUP_INTERVAL_MS = 60_000
  const SPECULATION_PENDING_TTL_MS = 120_000
  const SESSION_ROLLUP_HISTORY_KEY = "aegis_history_rollups"
  const MAX_ROLLUP_HISTORY_ENTRIES = 120

  /** @type {Map<string, { allocatedAt: number, payload: object }>} */
  const pendingSpeculationByKey = new Map()

  class AegisMetricsAggregator {
    constructor() {
      this.resetCounters()
    }

    resetCounters() {
      this.metrics = {
        scrub_prewarm_total: 0,
        scrub_prewarm_skipped_dedup: 0,
        speculative_allocated: 0,
        speculative_hits: 0,
        speculative_misses: 0,
        speculative_time_saved_ms_total: 0,
        total_stall_duration_ms: 0,
        z_axis_kalman_resets: 0
      }
    }

    recordEvent(type, metadata = {}) {
      const event = String(type || "")
      switch (event) {
        case "scrub_prewarm_total":
          this.metrics.scrub_prewarm_total += 1
          break
        case "scrub_prewarm_skipped_dedup":
          this.metrics.scrub_prewarm_skipped_dedup += 1
          break
        case "speculative_allocated":
          this.metrics.speculative_allocated += 1
          break
        case "speculative_hit":
          this.metrics.speculative_hits += 1
          if (Number.isFinite(metadata.time_saved_ms)) {
            this.metrics.speculative_time_saved_ms_total += Math.max(0, metadata.time_saved_ms)
          }
          break
        case "speculative_miss":
          this.metrics.speculative_misses += 1
          break
        case "playback_stall":
          if (Number.isFinite(metadata.duration_ms)) {
            this.metrics.total_stall_duration_ms += Math.max(0, metadata.duration_ms)
          }
          break
        case "z_axis_kalman_reset":
          this.metrics.z_axis_kalman_resets += 1
          break
        default:
          break
      }
    }

    flushAndExport() {
      const allocated = this.metrics.speculative_allocated
      const hits = this.metrics.speculative_hits
      const misses = this.metrics.speculative_misses
      const efficiency_ratio =
        allocated > 0 ? Math.round((hits / allocated) * 1000) / 1000 : null
      const payload = {
        ...this.metrics,
        efficiency_ratio,
        timestamp: Date.now()
      }
      this.resetCounters()
      return payload
    }
  }

  const aggregator = new AegisMetricsAggregator()
  let rollupTimerStarted = false
  let lastRollupSnapshot = null

  function pendingKey(tabId, segmentIndex) {
    return `${tabId}:${Math.round(segmentIndex)}`
  }

  function pruneExpiredPending(now = Date.now()) {
    for (const [key, entry] of pendingSpeculationByKey.entries()) {
      if (now - Number(entry?.allocatedAt || 0) > SPECULATION_PENDING_TTL_MS) {
        pendingSpeculationByKey.delete(key)
        aggregator.recordEvent("speculative_miss")
      }
    }
  }

  function recordMetricsEvent(type, metadata = {}) {
    aggregator.recordEvent(type, metadata)
  }

  function recordSpeculationAllocated(payload = {}) {
    const tabId = Number(payload.tab_id ?? payload.tabId)
    const segmentIndex = Number(payload.target_segment_index ?? payload.segmentIndex)
    if (!Number.isFinite(tabId) || !Number.isFinite(segmentIndex)) return

    pruneExpiredPending()
    const key = pendingKey(tabId, segmentIndex)
    const record = {
      event: "SPECULATION_ALLOCATED",
      tab_id: tabId,
      confidence: Number(payload.confidence) || 0,
      buffer_runway_sec: Number(payload.buffer_runway_sec ?? payload.bufferRunwaySec) || 0,
      calculated_score: Number(payload.calculated_score ?? payload.calculatedScore) || 0,
      assigned_tier: payload.assigned_tier || payload.assignedTier || "NONE",
      target_segment_index: Math.round(segmentIndex),
      network_tier: payload.network_tier || payload.networkTier || "NOMINAL",
      bitrate_tier_used: payload.bitrate_tier_used || payload.bitrateTierUsed || null,
      allocated_at: Date.now()
    }
    pendingSpeculationByKey.set(key, { allocatedAt: record.allocated_at, payload: record })
    aggregator.recordEvent("speculative_allocated")
  }

  function tryResolveSpeculationAtSegment(tabId, segmentIndex, options = {}) {
    if (!Number.isFinite(tabId) || typeof segmentIndex !== "number") return null
    pruneExpiredPending()
    const key = pendingKey(tabId, segmentIndex)
    const pending = pendingSpeculationByKey.get(key)
    if (!pending) return null

    const now = Date.now()
    const timeSavedMs = Math.max(0, now - Number(pending.allocatedAt || now))
    const wasHit = options.was_hit !== false
    const resolved = {
      event: "SPECULATION_RESOLVED",
      tab_id: tabId,
      target_segment_index: Math.round(segmentIndex),
      was_hit: wasHit,
      time_saved_ms: wasHit ? timeSavedMs : 0,
      bitrate_tier_used:
        options.bitrate_tier_used ||
        options.bitrateTierUsed ||
        pending.payload?.bitrate_tier_used ||
        pending.payload?.assigned_tier ||
        null,
      resolve_source: options.resolve_source || options.source || "chunk-observed"
    }

    pendingSpeculationByKey.delete(key)
    if (wasHit) {
      aggregator.recordEvent("speculative_hit", { time_saved_ms: timeSavedMs })
    } else {
      aggregator.recordEvent("speculative_miss")
    }

    return resolved
  }

  function recordScrubPrewarmScheduled() {
    aggregator.recordEvent("scrub_prewarm_total")
  }

  function recordScrubPrewarmSkippedDedup() {
    aggregator.recordEvent("scrub_prewarm_skipped_dedup")
  }

  function recordKalmanStateReset() {
    aggregator.recordEvent("z_axis_kalman_reset")
  }

  function recordPlaybackStallForRollup(durationMs = 0) {
    aggregator.recordEvent("playback_stall", { duration_ms: durationMs })
  }

  const CACHE_ROLLUP_METRICS = [
    "storeDedupSkipped",
    "storeDedupInvariantCrcSkipped",
    "storeDedupUrlWindowSkipped",
    "recentlyEvictedMisses",
    "cacheMissNeverStored",
    "evictedMissUnmapped",
    "cacheChunksEvicted",
    "beltLookupMisses",
    "beltLookupTimeouts",
    "beltLookupRecentlyEvictedMisses",
    "beltLookupMissNeverStored",
    "lookupMappingChecks",
    "lookupMappingResolved",
    "lookupMappingUnresolved",
    "cacheLookups",
    "cacheHits",
    "cacheMisses",
    "cachedChunks",
    "cacheFillWrites",
    "cacheFillBytes",
    "prefetchFillWrites",
    "prefetchFillBytes"
  ]

  let lastCacheRollupBaseline = Object.create(null)

  function snapshotCacheRollupDeltas() {
    const stats = ns.state?.stats || {}
    const deltas = {}
    for (const metric of CACHE_ROLLUP_METRICS) {
      const current = Number(stats[metric]) || 0
      deltas[metric] = Math.max(0, current - (lastCacheRollupBaseline[metric] || 0))
      lastCacheRollupBaseline[metric] = current
    }
    const classifiedMisses = deltas.recentlyEvictedMisses + deltas.cacheMissNeverStored
    deltas.recentlyEvictedMissRatePercent =
      classifiedMisses > 0
        ? Math.round((deltas.recentlyEvictedMisses / classifiedMisses) * 100)
        : null
    const lookupMappingChecks =
      deltas.lookupMappingChecks > 0
        ? deltas.lookupMappingChecks
        : deltas.lookupMappingResolved + deltas.lookupMappingUnresolved
    deltas.lookupMappingCoveragePercent =
      lookupMappingChecks > 0
        ? Math.round((deltas.lookupMappingResolved / lookupMappingChecks) * 1000) / 10
        : null
    const beltClassified = deltas.beltLookupRecentlyEvictedMisses + deltas.beltLookupMissNeverStored
    deltas.beltLookupClassified = beltClassified
    deltas.beltLookupRecentlyEvictedMissRatePercent =
      beltClassified > 0
        ? Math.round((deltas.beltLookupRecentlyEvictedMisses / beltClassified) * 100)
        : null
    const hitDenominator = deltas.cacheHits + deltas.cacheMisses
    deltas.cacheHitRatePercent =
      hitDenominator > 0 ? Math.round((deltas.cacheHits / hitDenominator) * 100) : null
    return deltas
  }

  function formatRollupLogLine(rollup) {
    const eff =
      rollup.efficiency_ratio != null
        ? `${Math.round(rollup.efficiency_ratio * 100)}%`
        : "n/a"
    const cache = rollup.cache || {}
    const evictMissRate =
      cache.recentlyEvictedMissRatePercent != null
        ? `${cache.recentlyEvictedMissRatePercent}%`
        : "n/a"
    const lookupCoverage =
      cache.lookupMappingCoveragePercent != null ? `${cache.lookupMappingCoveragePercent}%` : "n/a"
    const beltEvictRate =
      cache.beltLookupRecentlyEvictedMissRatePercent != null
        ? `${cache.beltLookupRecentlyEvictedMissRatePercent}%`
        : "n/a"
    const cacheHitRate =
      cache.cacheHitRatePercent != null ? `${cache.cacheHitRatePercent}%` : "n/a"
    return [
      `scrub=${rollup.scrub_prewarm_total}(skip=${rollup.scrub_prewarm_skipped_dedup})`,
      `spec=alloc ${rollup.speculative_allocated} hit ${rollup.speculative_hits} miss ${rollup.speculative_misses} eff ${eff}`,
      `saved=${rollup.speculative_time_saved_ms_total}ms`,
      `stalls=${rollup.total_stall_duration_ms}ms`,
      `kalmanResets=${rollup.z_axis_kalman_resets}`,
      `lookups=${cache.cacheLookups || 0}(hits=${cache.cacheHits || 0},miss=${cache.cacheMisses || 0},hitRate=${cacheHitRate})`,
      `fill=${cache.cachedChunks || 0}/${cache.cacheFillWrites || 0}(${formatBytesMb(cache.cacheFillBytes || 0)},prefetch=${cache.prefetchFillWrites || 0})`,
      `cacheDedup=${cache.storeDedupSkipped || 0}(crc=${cache.storeDedupInvariantCrcSkipped || 0},url=${cache.storeDedupUrlWindowSkipped || 0})`,
      `lookupMap=${cache.lookupMappingChecks || 0}(ok=${cache.lookupMappingResolved || 0},miss=${cache.lookupMappingUnresolved || 0},coverage=${lookupCoverage})`,
      `evictMiss=${cache.recentlyEvictedMisses || 0}(${evictMissRate})`,
      `beltMiss=${cache.beltLookupMisses || 0}(timeout=${cache.beltLookupTimeouts || 0},evict=${cache.beltLookupRecentlyEvictedMisses || 0}/${cache.beltLookupClassified || 0},rate=${beltEvictRate})`,
      `evictMissUnmapped=${cache.evictedMissUnmapped || 0}`,
      `cacheEvicted=${cache.cacheChunksEvicted || 0}`
    ].join(", ")
  }

  function formatBytesMb(bytes) {
    const value = Number(bytes) || 0
    return `${(value / (1024 * 1024)).toFixed(1)}MB`
  }

  async function sinkRollupToSessionStorage(flushPayload) {
    if (typeof chrome === "undefined" || !chrome.storage?.session?.get) return false
    try {
      const data = await chrome.storage.session.get(SESSION_ROLLUP_HISTORY_KEY)
      const history = Array.isArray(data?.[SESSION_ROLLUP_HISTORY_KEY])
        ? data[SESSION_ROLLUP_HISTORY_KEY]
        : []
      history.push({
        ...flushPayload,
        timestamp: Number(flushPayload?.timestamp) || Date.now()
      })
      while (history.length > MAX_ROLLUP_HISTORY_ENTRIES) {
        history.shift()
      }
      await chrome.storage.session.set({ [SESSION_ROLLUP_HISTORY_KEY]: history })
      return true
    } catch (err) {
      if (typeof addLog === "function") {
        addLog(
          "WARN",
          `[Aegis Aggregator] rollup session sink failed: ${err?.message || err}`
        )
      }
      return false
    }
  }

  async function getMetricsRollupHistory() {
    if (typeof chrome === "undefined" || !chrome.storage?.session?.get) return []
    try {
      const data = await chrome.storage.session.get(SESSION_ROLLUP_HISTORY_KEY)
      const history = data?.[SESSION_ROLLUP_HISTORY_KEY]
      return Array.isArray(history) ? history : []
    } catch {
      return []
    }
  }

  function flushMetricsRollup(forceLog = true) {
    pruneExpiredPending()
    const rollup = aggregator.flushAndExport()
    rollup.cache = snapshotCacheRollupDeltas()
    lastRollupSnapshot = rollup
    if (!ns.state) ns.state = {}
    if (!ns.state.telemetry) ns.state.telemetry = {}
    ns.state.telemetry.metricsRollup = rollup
    void sinkRollupToSessionStorage(rollup)
    if (forceLog && typeof addLog === "function") {
      addLog("INFO", `AegisStream 60s metrics rollup — ${formatRollupLogLine(rollup)}`)
    }
    return rollup
  }

  function startMetricsAggregatorRollup() {
    if (rollupTimerStarted) return
    rollupTimerStarted = true
    setInterval(() => flushMetricsRollup(true), ROLLUP_INTERVAL_MS)
  }

  function getLastMetricsRollup() {
    return lastRollupSnapshot
  }

  ns.AegisMetricsAggregator = AegisMetricsAggregator
  ns.recordMetricsEvent = recordMetricsEvent
  ns.recordSpeculationAllocated = recordSpeculationAllocated
  ns.tryResolveSpeculationAtSegment = tryResolveSpeculationAtSegment
  ns.recordScrubPrewarmScheduled = recordScrubPrewarmScheduled
  ns.recordScrubPrewarmSkippedDedup = recordScrubPrewarmSkippedDedup
  ns.recordKalmanStateReset = recordKalmanStateReset
  ns.recordPlaybackStallForRollup = recordPlaybackStallForRollup
  ns.flushMetricsRollup = flushMetricsRollup
  ns.startMetricsAggregatorRollup = startMetricsAggregatorRollup
  ns.getLastMetricsRollup = getLastMetricsRollup
  ns.sinkRollupToSessionStorage = sinkRollupToSessionStorage
  ns.getMetricsRollupHistory = getMetricsRollupHistory
  ns.SESSION_ROLLUP_HISTORY_KEY = SESSION_ROLLUP_HISTORY_KEY
})()
