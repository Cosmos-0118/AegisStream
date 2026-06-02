(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog, bumpActivity } = ns

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
  const lookups = state.stats.youtubeUmpLookups || 0
  const requests = state.stats.youtubeUmpRequests || 0
  if (!force && requests === 0 && lookups === 0) return

  state.telemetry.lastUmpHealthLogAt = now
  const hits = state.stats.youtubeUmpLookupHits || 0
  const misses = state.stats.youtubeUmpLookupMisses || 0
  const warmups = state.stats.youtubeUmpWarmups || 0
  const captureSkipped = state.stats.youtubeUmpCaptureSkipped || 0
  const effective = hits + misses + warmups
  const hitRate = effective > 0 ? Math.round((hits / effective) * 100) : 0
  const stallSeconds = (state.stats.videoStallMsTotal / 1000).toFixed(1)
  const modeLabel =
    requests > 0 || lookups > 0 ? "YouTube realtime health" : "AegisStream realtime health"
  addLog(
    "INFO",
    `${modeLabel} — req=${requests}, lookups=${lookups}, hits=${hits}, miss=${misses}, warmup=${warmups}, hitRate=${hitRate}%, ttfb_p95=${state.stats.requestFirstByteP95Ms}ms, stalls=${state.stats.videoStalls} (${stallSeconds}s), umpStreams(abort/error)=${state.stats.youtubeUmpStreamsAborted}/${state.stats.youtubeUmpStreamsErrored}, captureSkipped=${captureSkipped}`
  )
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
  if (metricType === "buffer_health") {
    const runwaySec = Number(message.runwaySec)
    if (!Number.isFinite(runwaySec) || runwaySec < 0) return
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
  if (state.stats.videoStalls % 5 === 0) {
    maybeLogUmpHealthSummary(true)
  }
}

ns.handleRuntimeMetric = handleRuntimeMetric
ns.rememberUmpLookupKey = rememberUmpLookupKey
ns.maybeLogUmpHealthSummary = maybeLogUmpHealthSummary
})()
