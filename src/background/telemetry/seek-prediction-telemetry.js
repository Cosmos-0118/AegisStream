(() => {
var ns = (self.AegisBackground ||= {})
const { addLog, bumpActivity } = ns

const MAX_ERROR_SAMPLES = 240
const RESOLVE_WINDOW_MS = 12_000
const SUMMARY_LOG_INTERVAL_MS = 30_000

const pendingByTab = new Map()
const errorSamples = []
let lastSummaryLogAt = 0

function computePercentile(values, percentile) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((percentile / 100) * (sorted.length - 1)))
  )
  return sorted[idx]
}

function recordSeekPrediction(tabId, payload) {
  if (!Number.isFinite(tabId) || !payload) return
  const predictedIndex = Number(payload.predictedIndex)
  if (!Number.isFinite(predictedIndex)) return

  const entry = {
    predictedIndex: Math.round(predictedIndex),
    currentTimeSec: Number(payload.currentTimeSec),
    previousIndex:
      typeof payload.previousIndex === "number" ? payload.previousIndex : null,
    teleport: payload.teleport === true,
    source: payload.source || "seek-prediction",
    at: Date.now()
  }
  pendingByTab.set(tabId, entry)
  bumpActivity("seekPredictions", 1)

  const timeLabel = Number.isFinite(entry.currentTimeSec)
    ? `${entry.currentTimeSec.toFixed(1)}s`
    : "n/a"
  addLog(
    "INFO",
    `Seek prediction on tab ${tabId}: time=${timeLabel}, estimatedIndex=${entry.predictedIndex}${entry.teleport ? ", teleportEligible=true" : ""}`
  )
}

function resolveSeekPredictionActual(tabId, actualIndex, options = {}) {
  if (!Number.isFinite(tabId) || typeof actualIndex !== "number") return null
  const pending = pendingByTab.get(tabId)
  if (!pending) return null

  const now = Date.now()
  if (now - pending.at > RESOLVE_WINDOW_MS) {
    pendingByTab.delete(tabId)
    bumpActivity("seekPredictionExpired", 1)
    return null
  }

  const actual = Math.round(actualIndex)
  const predicted = pending.predictedIndex
  const error = Math.abs(actual - predicted)
  const signedError = actual - predicted

  pendingByTab.delete(tabId)
  errorSamples.push(error)
  if (errorSamples.length > MAX_ERROR_SAMPLES) {
    errorSamples.splice(0, errorSamples.length - MAX_ERROR_SAMPLES)
  }

  bumpActivity("seekPredictionResolved", 1)
  if (error <= 3) bumpActivity("seekPredictionWithin3", 1)
  if (error <= 1) bumpActivity("seekPredictionWithin1", 1)

  const source = options.source || "player-segment"
  addLog(
    error <= 3 ? "INFO" : "WARN",
    `Seek prediction resolved (${source}, tab ${tabId}): prediction=${predicted}, actual=${actual}, error=${error}${signedError !== 0 ? ` (${signedError > 0 ? "+" : ""}${signedError})` : ""}`
  )

  maybeLogSeekPredictionSummary(false)

  return { predicted, actual, error, signedError, currentTimeSec: pending.currentTimeSec }
}

function getSeekPredictionSummary() {
  const samples = errorSamples.length
  if (samples === 0) {
    return {
      samples: 0,
      meanError: 0,
      p95Error: 0,
      pending: pendingByTab.size
    }
  }
  const sum = errorSamples.reduce((acc, value) => acc + value, 0)
  return {
    samples,
    meanError: Math.round((sum / samples) * 100) / 100,
    p95Error: computePercentile(errorSamples, 95),
    pending: pendingByTab.size
  }
}

function maybeLogSeekPredictionSummary(force = false) {
  const summary = getSeekPredictionSummary()
  if (summary.samples === 0 && summary.pending === 0) return
  const now = Date.now()
  if (!force && now - lastSummaryLogAt < SUMMARY_LOG_INTERVAL_MS) return
  lastSummaryLogAt = now
  addLog(
    "INFO",
    `Seek prediction accuracy — samples=${summary.samples}, meanError=${summary.meanError} segments, p95Error=${summary.p95Error} segments, pending=${summary.pending}`
  )
}

function resetSeekPredictionTelemetry() {
  pendingByTab.clear()
  errorSamples.length = 0
  lastSummaryLogAt = 0
}

ns.recordSeekPrediction = recordSeekPrediction
ns.resolveSeekPredictionActual = resolveSeekPredictionActual
ns.getSeekPredictionSummary = getSeekPredictionSummary
ns.maybeLogSeekPredictionSummary = maybeLogSeekPredictionSummary
ns.resetSeekPredictionTelemetry = resetSeekPredictionTelemetry
})()
