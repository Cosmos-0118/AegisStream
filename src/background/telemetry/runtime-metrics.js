(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog, bumpActivity, noteTabPageUrl, isReactivePrefetchTab } = ns

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
      `YouTube realtime health — req=${ump.requests || 0}, lookups=${umpLookups}, hits=${ump.hits}, miss=${ump.misses}, warmup=${ump.warmups}, hitRate=${hitRate}%, hls(h=${hls.hits}/m=${hls.misses}), ttfb_p95=${state.stats.requestFirstByteP95Ms}ms, net_ttfb_p95=${state.stats.networkFirstByteP95Ms || 0}ms${panicLabel}, stalls=${stallCount} (${stallSeconds}s), umpStreams(abort/error)=${state.stats.youtubeUmpStreamsAborted}/${state.stats.youtubeUmpStreamsErrored}, captureSkipped=${captureSkipped}${extensionFetchLine ? `, ${extensionFetchLine}` : ""}${workerLine ? `, ${workerLine}` : ""}`
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
      ? `, seekPred(mean=${seekSummary.meanError}, p95=${seekSummary.p95Error}, n=${seekSummary.samples})`
      : ""
  const anchorLine =
    typeof ns.formatAnchorOwnershipLine === "function"
      ? `, ${ns.formatAnchorOwnershipLine()}`
      : ""
  addLog(
    "INFO",
    `AegisStream realtime health — lookups=${hlsLookups}, hits=${hls.hits}, miss=${hls.misses}, warmup=${hls.warmups}, hitRate=${hitRate}%, ttfb_p95=${state.stats.requestFirstByteP95Ms}ms, net_ttfb_p95=${state.stats.networkFirstByteP95Ms || 0}ms${panicLabel}, stalls=${stallCount} (${stallSeconds}s)${seekLine}${anchorLine}, umpStreams(abort/error)=${state.stats.youtubeUmpStreamsAborted}/${state.stats.youtubeUmpStreamsErrored}, captureSkipped=${captureSkipped}${extensionFetchLine ? `, ${extensionFetchLine}` : ""}${workerLine ? `, ${workerLine}` : ""}`
  )
  if (typeof ns.maybeLogSeekPredictionSummary === "function") {
    ns.maybeLogSeekPredictionSummary(force)
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

  if (metricType === "buffer_health") {
    const runwaySec = Number(message.runwaySec)
    if (!Number.isFinite(runwaySec) || runwaySec < 0) return
    if (typeof message.pageUrl === "string" && typeof ns.noteTabPageUrl === "function") {
      noteTabPageUrl(tabId, message.pageUrl)
    }
    if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) {
      return
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
  state.stats.videoStallLongestMs = Math.max(state.stats.videoStallLongestMs, durationMs)
  const reason = typeof message.reason === "string" ? message.reason : "unknown"
  const atSeconds = Number.isFinite(message.atSeconds) ? Number(message.atSeconds).toFixed(1) : "n/a"
  const tabLabel = tabId ? `tab ${tabId}` : "tab ?"
  addLog(
    durationMs >= 1000 ? "WARN" : "INFO",
    `Playback stall ${Math.round(durationMs)}ms (${reason}) on ${tabLabel} at ${atSeconds}s`
  )
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
})()
