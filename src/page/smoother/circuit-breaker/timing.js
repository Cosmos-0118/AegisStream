(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("circuit-timing")) {
  return
}

const smoother = ns.smoother
if (!smoother) return

const FALLBACK_MS = smoother.CIRCUIT_BREAKER_MS || 2500
const MIN_MS = 1200
const MAX_MS = 8000
const RTT_MULTIPLIER = 12
const RTT_BASE_MS = 400
const MAX_SAMPLES = 32
const EMA_ALPHA = 0.28
const RESOURCE_SCAN_INTERVAL_MS = 5000

const STATIC_TIMING_EXT = /\.(js|css|woff2?|ttf)(\?|$)/i

let rttEmaMs = null
let lastResourceScanAt = 0
let connectionListenerBound = false

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function getNetworkConnection() {
  return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null
}

function effectiveTypePriorMs(effectiveType) {
  switch (effectiveType) {
    case "slow-2g":
      return 2000
    case "2g":
      return 1400
    case "3g":
      return 400
    case "4g":
      return 80
    default:
      return null
  }
}

function readConnectionRttMs() {
  const conn = getNetworkConnection()
  if (!conn) return null
  const reported = Number(conn.rtt)
  if (Number.isFinite(reported) && reported > 0) return reported
  return effectiveTypePriorMs(conn.effectiveType)
}

function recordRttSample(sampleMs) {
  const ms = Number(sampleMs)
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MS) return
  rttEmaMs =
    rttEmaMs === null ? ms : Math.round(rttEmaMs * (1 - EMA_ALPHA) + ms * EMA_ALPHA)
}

function ingestResourceTimings() {
  const now = Date.now()
  if (now - lastResourceScanAt < RESOURCE_SCAN_INTERVAL_MS) return
  lastResourceScanAt = now

  let entries = []
  try {
    entries = performance.getEntriesByType("resource")
  } catch {
    return
  }

  const slice = entries.length > 60 ? entries.slice(-60) : entries
  for (const entry of slice) {
    if (!entry?.name || !STATIC_TIMING_EXT.test(entry.name)) continue
    const start = Number(entry.startTime)
    const responseStart = Number(entry.responseStart)
    let sample = null
    if (responseStart > 0 && start >= 0) {
      sample = responseStart - start
    } else {
      const duration = Number(entry.duration)
      if (duration > 0) sample = duration
    }
    if (sample != null) recordRttSample(sample)
  }
}

function bindConnectionChangeListener() {
  if (connectionListenerBound) return
  const conn = getNetworkConnection()
  if (!conn || typeof conn.addEventListener !== "function") return
  connectionListenerBound = true
  conn.addEventListener("change", () => {
    const rtt = readConnectionRttMs()
    if (rtt != null) recordRttSample(rtt)
  })
}

function getEstimatedRttMs() {
  bindConnectionChangeListener()
  ingestResourceTimings()

  const connectionRtt = readConnectionRttMs()
  if (rttEmaMs != null && connectionRtt != null) {
    return Math.round(rttEmaMs * 0.55 + connectionRtt * 0.45)
  }
  if (rttEmaMs != null) return Math.round(rttEmaMs)
  if (connectionRtt != null) return Math.round(connectionRtt)
  return null
}

function getAdaptiveCircuitBreakerMs() {
  const rtt = getEstimatedRttMs()
  if (!Number.isFinite(rtt) || rtt <= 0) return FALLBACK_MS
  return clamp(Math.round(rtt * RTT_MULTIPLIER + RTT_BASE_MS), MIN_MS, MAX_MS)
}

function recordCircuitBreakerSample(durationMs) {
  recordRttSample(durationMs)
}

smoother.CIRCUIT_BREAKER_MIN_MS = MIN_MS
smoother.CIRCUIT_BREAKER_MAX_MS = MAX_MS
smoother.CIRCUIT_BREAKER_RTT_MULTIPLIER = RTT_MULTIPLIER
smoother.getAdaptiveCircuitBreakerMs = getAdaptiveCircuitBreakerMs
smoother.recordCircuitBreakerSample = recordCircuitBreakerSample
smoother.getEstimatedRttMs = getEstimatedRttMs
})()
