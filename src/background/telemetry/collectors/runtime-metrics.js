(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog, noteTabPageUrl, isReactivePrefetchTab } = ns

function bumpActivity(metric, amount = 1) {
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity(metric, amount)
  }
}

function sanitizeMetricLatencyMs(value) {
  const latency = Number(value)
  if (!Number.isFinite(latency) || latency < 0) return null
  return Math.round(latency)
}

function pushRollingSample(target, value, maxSize = constants.MAX_TTFB_SAMPLES) {
  if (!Number.isFinite(value)) return
  target.push(value)
  if (target.length > maxSize) {
    target.splice(0, target.length - maxSize)
  }
}

function computeAverage(values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const sum = values.reduce((acc, value) => acc + value, 0)
  return Math.round(sum / values.length)
}

function computePercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((percentile / 100) * (sorted.length - 1)))
  )
  return Math.round(sorted[idx])
}

function refreshFirstByteStats() {
  const all = state.telemetry.firstByteAll
  const cache = state.telemetry.firstByteCache
  const network = state.telemetry.firstByteNetwork
  state.stats.requestFirstByteSamples = all.length
  state.stats.requestFirstByteAvgMs = computeAverage(all)
  state.stats.requestFirstByteP95Ms = computePercentile(all, 95)
  state.stats.cacheFirstByteAvgMs = computeAverage(cache)
  state.stats.networkFirstByteAvgMs = computeAverage(network)
  state.stats.networkFirstByteP95Ms = computePercentile(network, 95)
  if (typeof ns.syncNetworkPanicMode === "function") {
    ns.syncNetworkPanicMode()
  }
}

const CHUNK_CAPTURE_SOURCES = new Set([
  "xhr-sync",
  "xhr-load",
  "fetch-clone",
  "fetch-tee",
  "ump",
  "prefetch",
  "range-buffer",
  "cross-itag",
  "unknown"
])

function normalizeChunkCaptureSource(source) {
  const normalized = String(source || "unknown").toLowerCase()
  return CHUNK_CAPTURE_SOURCES.has(normalized) ? normalized : "unknown"
}

function ensureChunkStoreBucket(source) {
  if (!state.telemetry.chunkStore) {
    state.telemetry.chunkStore = {
      successfulStores: 0,
      failedStores: 0,
      totalBytesStored: 0,
      bySource: {}
    }
  }
  const bucket = state.telemetry.chunkStore
  if (!bucket.bySource[source]) {
    bucket.bySource[source] = { success: 0, failed: 0, bytes: 0 }
  }
  return bucket.bySource[source]
}

function recordChunkStoreOutcomeMetric(message) {
  const source = normalizeChunkCaptureSource(message.captureSource)
  const ok = message.ok === true
  const byteLength = Number(message.byteLength)
  const bucket = ensureChunkStoreBucket(source)
  const totals = state.telemetry.chunkStore

  if (ok) {
    totals.successfulStores += 1
    bucket.success += 1
    if (Number.isFinite(byteLength) && byteLength > 0) {
      totals.totalBytesStored += byteLength
      bucket.bytes += byteLength
    }
  } else {
    totals.failedStores += 1
    bucket.failed += 1
    if (typeof ns.notePainStoreFailed === "function") {
      ns.notePainStoreFailed(source)
    }
  }
}

function formatChunkStoreTelemetryLine() {
  const totals = state.telemetry.chunkStore
  if (!totals) return ""
  const attempts = (totals.successfulStores || 0) + (totals.failedStores || 0)
  if (attempts === 0) return ""

  const bySource = Object.entries(totals.bySource || {})
    .filter(([, stats]) => (stats?.success || 0) > 0)
    .sort((a, b) => (b[1]?.success || 0) - (a[1]?.success || 0))
    .map(([source, stats]) => `${source}=${stats.success}`)
    .join(", ")

  const avgKb =
    totals.successfulStores > 0
      ? (totals.totalBytesStored / totals.successfulStores / 1024).toFixed(1)
      : "0"

  return `stores(ok=${totals.successfulStores}, fail=${totals.failedStores}, avgKB=${avgKb}${bySource ? `, ${bySource}` : ""})`
}

function shouldEmitThrottledLog(key, intervalMs) {
  const now = Date.now()
  const last = state.telemetry.logThrottleByKey.get(key) || 0
  if (now - last < intervalMs) return false
  state.telemetry.logThrottleByKey.set(key, now)
  return true
}

function maybeLogUmpHealthSummary(force = false) {
  const now = Date.now()
  if (!force && now - state.telemetry.lastUmpHealthLogAt < constants.UMP_HEALTH_LOG_INTERVAL_MS) {
    return
  }

  const snapshot =
    typeof ns.metrics?.getSnapshot === "function" ? ns.metrics.getSnapshot() : null
  const hls = snapshot?.hls || {
    lookups: state.stats.cacheLookups || 0,
    hits: state.stats.cacheHits || 0,
    misses: state.stats.cacheMisses || 0,
    warmups: state.stats.cacheWarmups || 0
  }
  const ump = snapshot?.ump || {
    requests: state.stats.youtubeUmpRequests || 0,
    lookups: state.stats.youtubeUmpLookups || 0,
    hits: state.stats.youtubeUmpLookupHits || 0,
    misses: state.stats.youtubeUmpLookupMisses || 0,
    warmups: state.stats.youtubeUmpWarmups || 0
  }
  const hasUmp = (ump.requests || 0) > 0 || (ump.lookups || 0) > 0
  const hasHls = (hls.lookups || 0) > 0 || (hls.hits || 0) > 0 || (hls.misses || 0) > 0
  const stallCount = state.stats.videoStalls || 0

  if (!force && !hasUmp && !hasHls && stallCount === 0) return

  state.telemetry.lastUmpHealthLogAt = now
  const captureSkipped = state.stats.youtubeUmpCaptureSkipped || 0
  const stallSeconds = (state.stats.videoStallMsTotal / 1000).toFixed(1)
  const extensionFetchLine =
    typeof ns.formatExtensionFetchMetricsLine === "function"
      ? ns.formatExtensionFetchMetricsLine()
      : ""
  const chunkStoreLine = formatChunkStoreTelemetryLine()
  const congestionLine =
    typeof ns.formatCongestionTelemetryLineGlobal === "function"
      ? ns.formatCongestionTelemetryLineGlobal()
      : ""
  const workerLifecycle =
    typeof ns.getWorkerLifecycleSnapshot === "function"
      ? ns.getWorkerLifecycleSnapshot()
      : null
  const workerLine = workerLifecycle
    ? `SW starts=#${workerLifecycle.workerStartCount}, reason=${workerLifecycle.workerRestartReason || "unknown"}`
    : ""
  const panicLabel =
    typeof ns.isNetworkPanicActive === "function" && ns.isNetworkPanicActive()
      ? ", panic=ON"
      : ""
  const combined = snapshot?.combined

  if (hasUmp) {
    const umpLookups = ump.lookups || ump.hits + ump.misses + ump.warmups
    const effective = ump.hits + ump.misses + ump.warmups
    const hitRate = effective > 0 ? Math.round((ump.hits / effective) * 100) : 0
    addLog(
      "INFO",
      `YouTube realtime health — req=${ump.requests || 0}, lookups=${umpLookups}, hits=${ump.hits}, miss=${ump.misses}, warmup=${ump.warmups}, hitRate=${hitRate}%, hls(h=${hls.hits}/m=${hls.misses}), ttfb_p95=${state.stats.requestFirstByteP95Ms}ms, net_ttfb_p95=${state.stats.networkFirstByteP95Ms || 0}ms${panicLabel}, stalls=${stallCount} (${stallSeconds}s), umpStreams(abort/error)=${state.stats.youtubeUmpStreamsAborted}/${state.stats.youtubeUmpStreamsErrored}, captureSkipped=${captureSkipped}${chunkStoreLine ? `, ${chunkStoreLine}` : ""}${congestionLine ? `, ${congestionLine}` : ""}${extensionFetchLine ? `, ${extensionFetchLine}` : ""}${workerLine ? `, ${workerLine}` : ""}`
    )
    return
  }

  const hlsLookups = hls.lookups || hls.hits + hls.misses + hls.warmups
  const hitRateDenominator = hls.hits + hls.misses
  const hitRate =
    hitRateDenominator > 0
      ? Math.round((hls.hits / hitRateDenominator) * 100)
      : combined?.hitRatePercent || 0
  const seekSummary =
    typeof ns.getSeekPredictionSummary === "function"
      ? ns.getSeekPredictionSummary()
      : null
  const seekLine =
    seekSummary && seekSummary.samples > 0
      ? `, seekPred(mean=${seekSummary.meanError}, p95=${seekSummary.p95Error}, conf=${Math.round((seekSummary.confidence || 0) * 100)}%, hitRate=${Math.round((seekSummary.hitRate || 0) * 100)}%, predictor=${seekSummary.enabled ? "ON" : "OFF"}, speculative=${seekSummary.speculative ? "ON" : "OFF"}, n=${seekSummary.samples})`
      : ""
  const anchorLine =
    typeof ns.formatAnchorOwnershipLine === "function"
      ? `, ${ns.formatAnchorOwnershipLine()}`
      : ""
  const inflightLine =
    typeof ns.formatInflightAccountingLine === "function"
      ? `, ${ns.formatInflightAccountingLine()}`
      : ""
  const rescueLine =
    typeof ns.formatRescueTelemetryLine === "function" ? ns.formatRescueTelemetryLine() : ""
  const rescueTelemetry = rescueLine ? `, ${rescueLine}` : ""
  addLog(
    "INFO",
    `AegisStream realtime health — lookups=${hlsLookups}, hits=${hls.hits}, miss=${hls.misses}, warmup=${hls.warmups}, hitRate=${hitRate}%, ttfb_p95=${state.stats.requestFirstByteP95Ms}ms, net_ttfb_p95=${state.stats.networkFirstByteP95Ms || 0}ms${panicLabel}, stalls=${stallCount} (${stallSeconds}s)${seekLine}${anchorLine}${inflightLine}${rescueTelemetry}, umpStreams(abort/error)=${state.stats.youtubeUmpStreamsAborted}/${state.stats.youtubeUmpStreamsErrored}, captureSkipped=${captureSkipped}${chunkStoreLine ? `, ${chunkStoreLine}` : ""}${congestionLine ? `, ${congestionLine}` : ""}${extensionFetchLine ? `, ${extensionFetchLine}` : ""}${workerLine ? `, ${workerLine}` : ""}`
  )
  if (typeof ns.noteInflightMismatch === "function") {
    ns.noteInflightMismatch(ns.auditInflightAccounting(), "health-summary")
  }
  if (typeof ns.maybeLogSeekPredictionSummary === "function") {
    ns.maybeLogSeekPredictionSummary(force)
  }
  if (typeof ns.maybeLogObservabilitySummary === "function") {
    ns.maybeLogObservabilitySummary(force)
  }
}

function rememberUmpLookupKey(key) {
  const now = Date.now()
  if (state.umpLookupSeenAt.size > 5000) {
    const cutoff = now - 15 * 60 * 1000
    for (const [existingKey, ts] of state.umpLookupSeenAt.entries()) {
      if (ts < cutoff) {
        state.umpLookupSeenAt.delete(existingKey)
      }
    }
  }
  state.umpLookupSeenAt.set(key, now)
}

function handleRuntimeMetric(message, sender) {
  const metricType = message.metricType
  const tabId = sender?.tab?.id
  if (metricType === "seek_prediction") {
    const currentTime = Number(message.currentTime)
    if (!Number.isFinite(currentTime) || !Number.isFinite(tabId)) return
    if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) {
      return
    }
    if (typeof ns.handleSeekPrediction === "function") {
      ns.handleSeekPrediction(tabId, currentTime)
    }
    return
  }

  if (metricType === "player_paused") {
    if (Number.isFinite(tabId) && typeof ns.notePlayerPausedForSeekPrediction === "function") {
      ns.notePlayerPausedForSeekPrediction(tabId)
    }
    return
  }

  if (metricType === "buffer_health") {
    const runwaySec = Number(message.runwaySec)
    if (!Number.isFinite(runwaySec) || runwaySec < 0) return
    if (typeof message.pageUrl === "string" && typeof ns.noteTabPageUrl === "function") {
      noteTabPageUrl(tabId, message.pageUrl)
    }
    if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) {
      return
    }
    if (message.paused === true && typeof ns.notePlayerPausedForSeekPrediction === "function") {
      ns.notePlayerPausedForSeekPrediction(tabId)
    }
    if (typeof ns.updateTabBufferHealth === "function" && Number.isFinite(tabId)) {
      ns.updateTabBufferHealth(tabId, {
        runwaySec,
        runwayPct: Number(message.runwayPct),
        healthScore: Number(message.healthScore),
        tier: message.tier,
        netFillRate: message.netFillRate,
        paused: message.paused === true
      })
    }
    return
  }

  if (metricType === "youtube_ump_request") {
    if (typeof ns.recordStreamMetric === "function") {
      ns.recordStreamMetric("ump", "requests", 1)
    }
    bumpActivity("youtubeUmpRequests", 1)
    if (typeof message.bodyHash === "string" && message.bodyHash.length > 0) {
      state.telemetry.umpHashes.add(message.bodyHash)
      if (state.telemetry.umpHashes.size > 5000) {
        const toDelete = Array.from(state.telemetry.umpHashes).slice(0, 1000)
        for (const hash of toDelete) state.telemetry.umpHashes.delete(hash)
      }
      state.stats.youtubeUmpUniqueKeys = state.telemetry.umpHashes.size
    }
    if (
      state.stats.youtubeUmpRequests % 12 === 0 ||
      shouldEmitThrottledLog("ump_request_flow", 20_000)
    ) {
      maybeLogUmpHealthSummary()
    }
    return
  }

  if (metricType === "youtube_ump_stream_outcome") {
    const outcome = message.outcome
    const detail = typeof message.detail === "string" ? message.detail : null
    if (outcome === "completed") {
      state.stats.youtubeUmpStreamsCompleted += 1
    } else if (outcome === "capture_skipped") {
      state.stats.youtubeUmpCaptureSkipped += 1
      if (shouldEmitThrottledLog("ump_capture_backpressure", 8000)) {
        addLog("INFO", "UMP cache capture throttled to protect playback (backpressure)")
      }
    } else if (outcome === "aborted") {
      state.stats.youtubeUmpStreamsAborted += 1
      if (shouldEmitThrottledLog("ump_stream_aborted", 10_000)) {
        addLog("INFO", "YouTube UMP stream recycled/aborted; playback proxy recovered")
      }
    } else if (outcome === "error" || outcome === "store_failed") {
      state.stats.youtubeUmpStreamsErrored += 1
      if (shouldEmitThrottledLog(`ump_stream_${outcome}`, 3000)) {
        addLog(
          "WARN",
          `YouTube UMP stream issue (${outcome})${tabId ? ` on tab ${tabId}` : ""}${detail ? `: ${detail}` : ""}`
        )
      }
      maybeLogUmpHealthSummary()
    }
    return
  }

  if (metricType === "chunk_store_outcome") {
    recordChunkStoreOutcomeMetric(message)
    const totals = state.telemetry.chunkStore
    if (
      totals &&
      (totals.successfulStores + totals.failedStores) % 40 === 0 &&
      shouldEmitThrottledLog("chunk_store_telemetry", 15_000)
    ) {
      const line = formatChunkStoreTelemetryLine()
      if (line) addLog("INFO", `Chunk store telemetry — ${line}`)
    }
    return
  }

  if (metricType === "cache_lookup_skipped") {
    if (typeof ns.bumpActivity === "function") {
      ns.bumpActivity("cacheLookupSkipped", 1)
    }
    return
  }

  if (metricType === "request_collapse_hit") {
    if (!state.telemetry.requestCollapse) {
      state.telemetry.requestCollapse = {
        hits: 0,
        savedFetches: 0,
        savedBytes: 0
      }
    }
    const bucket = state.telemetry.requestCollapse
    bucket.hits += 1
    bucket.savedFetches += 1
    const savedBytes = Number(message.savedBytes)
    if (Number.isFinite(savedBytes) && savedBytes > 0) {
      bucket.savedBytes += savedBytes
    }
    if (
      bucket.hits % 25 === 0 &&
      shouldEmitThrottledLog("request_collapse_roi", 15_000)
    ) {
      const savedMb = (bucket.savedBytes / (1024 * 1024)).toFixed(1)
      addLog(
        "INFO",
        `Request collapse ROI — collapse_hits=${bucket.hits}, saved_fetches=${bucket.savedFetches}, saved_MB=${savedMb}`
      )
    }
    return
  }

  if (metricType === "request_first_byte") {
    const latencyMs = sanitizeMetricLatencyMs(message.latencyMs)
    if (latencyMs === null) return
    pushRollingSample(state.telemetry.firstByteAll, latencyMs)
    const source = String(message.source || "").toLowerCase()
    if (source.includes("cache")) {
      pushRollingSample(state.telemetry.firstByteCache, latencyMs)
      if (latencyMs >= 250 && shouldEmitThrottledLog("cache_ttfb_high", 12_000)) {
        addLog("WARN", `High cache first-byte latency detected: ${latencyMs}ms`)
      }
    } else {
      pushRollingSample(state.telemetry.firstByteNetwork, latencyMs)
      if (latencyMs >= 1500 && shouldEmitThrottledLog("network_ttfb_high", 12_000)) {
        addLog("WARN", `High network first-byte latency detected: ${latencyMs}ms`)
      }
    }
    refreshFirstByteStats()
    return
  }

  if (metricType !== "video_stall") return
  if (typeof isReactivePrefetchTab === "function" && isReactivePrefetchTab(tabId)) {
    return
  }
  const durationMs = sanitizeMetricLatencyMs(message.durationMs)
  if (durationMs === null) return
  bumpActivity("videoStalls", 1)
  bumpActivity("videoStallMsTotal", durationMs)
  if (typeof ns.notePainPlaybackStall === "function") {
    ns.notePainPlaybackStall(durationMs)
  }
  if (typeof ns.recordPlaybackStallForRollup === "function") {
    ns.recordPlaybackStallForRollup(durationMs)
  }
  state.stats.videoStallLongestMs = Math.max(state.stats.videoStallLongestMs, durationMs)
  const reason = typeof message.reason === "string" ? message.reason : "unknown"
  const atSeconds = Number.isFinite(message.atSeconds) ? Number(message.atSeconds).toFixed(1) : "n/a"
  const tabLabel = tabId ? `tab ${tabId}` : "tab ?"
  addLog(
    durationMs >= 1000 ? "WARN" : "INFO",
    `Playback stall ${Math.round(durationMs)}ms (${reason}) on ${tabLabel} at ${atSeconds}s`
  )
  if (Number.isFinite(tabId)) {
    const tabState = state.playlistByTab?.get(tabId)
    if (
      tabState &&
      typeof ns.maybeBreakPassengerLockForStallRecovery === "function" &&
      ns.maybeBreakPassengerLockForStallRecovery(tabId, tabState, {
        stall: true,
        isScrubbing: false,
        reason: "video-stall"
      }) &&
      typeof ns.handleSeekPrediction === "function" &&
      Number.isFinite(message.atSeconds)
    ) {
      ns.handleSeekPrediction(tabId, Number(message.atSeconds), { stallOverride: true })
    }
  }
  if (
    Number.isFinite(tabId) &&
    typeof ns.recordPlaybackResumedAfterStall === "function"
  ) {
    ns.recordPlaybackResumedAfterStall(tabId)
  }
  if (state.stats.videoStalls % 5 === 0) {
    maybeLogUmpHealthSummary(true)
  }
}

ns.handleRuntimeMetric = handleRuntimeMetric
ns.rememberUmpLookupKey = rememberUmpLookupKey
ns.maybeLogUmpHealthSummary = maybeLogUmpHealthSummary
ns.formatChunkStoreTelemetryLine = formatChunkStoreTelemetryLine
})()
