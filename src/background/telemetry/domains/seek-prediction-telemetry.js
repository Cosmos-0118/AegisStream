(() => {
var ns = (self.AegisBackground ||= {})
const { addLog } = ns

function bumpActivity(metric, amount = 1) {
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity(metric, amount)
  }
}

const MAX_ERROR_SAMPLES = 240
const RESOLVE_WINDOW_MS = 12_000
const SUMMARY_LOG_INTERVAL_MS = 30_000

const pendingByTab = new Map()
const errorSamples = []
const gaussianScores = []
let lastSummaryLogAt = 0
let resolvedCount = 0
let hitWithin3Count = 0
let penalizedConfidence = 0.5

function computePercentile(values, percentile) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((percentile / 100) * (sorted.length - 1)))
  )
  return sorted[idx]
}

function gaussianAccuracyScore(distance) {
  const sigma = Number(ns.constants?.SEEK_PREDICTION_GAUSSIAN_SIGMA) || 2
  const safeSigma = Math.max(0.5, sigma)
  return Math.exp(-(distance * distance) / (2 * safeSigma * safeSigma))
}

function blendConfidence(instantScore) {
  const alpha = Number(ns.constants?.SEEK_PREDICTION_CONFIDENCE_EMA_ALPHA) || 0.15
  const blend = resolvedCount < 8 ? Math.max(alpha, 0.35) : alpha
  penalizedConfidence = penalizedConfidence * (1 - blend) + instantScore * blend
  penalizedConfidence = Math.min(1, Math.max(0, penalizedConfidence))
}

function recordSeekPrediction(tabId, payload) {
  if (!Number.isFinite(tabId) || !payload) return
  const predictedIndex = Number(payload.predictedIndex)
  if (!Number.isFinite(predictedIndex)) return

  const source = payload.source || "seek-prediction"
  const ephemeral =
    payload.ephemeral === true ||
    source === "seek-prediction-scrub-suppressed" ||
    source === "seek-prediction-scrub-observe"

  const entry = {
    predictedIndex: Math.round(predictedIndex),
    currentTimeSec: Number(payload.currentTimeSec),
    previousIndex:
      typeof payload.previousIndex === "number" ? payload.previousIndex : null,
    teleport: payload.teleport === true,
    source,
    at: Date.now(),
    frozen: false
  }
  if (!ephemeral) {
    pendingByTab.set(tabId, entry)
  }
  bumpActivity("seekPredictions", 1)

  const timeLabel = Number.isFinite(entry.currentTimeSec)
    ? `${entry.currentTimeSec.toFixed(1)}s`
    : "n/a"
  const sourceLabel =
    entry.source === "seek-prediction-scrub-suppressed" ||
    entry.source === "seek-prediction-scrub-observe"
      ? ", passenger=true"
      : ""
  addLog(
    "INFO",
    `Seek prediction on tab ${tabId}: time=${timeLabel}, estimatedIndex=${entry.predictedIndex}${entry.teleport ? ", teleportEligible=true" : ""}${sourceLabel}`
  )
}

function evictSeekPredictionPending(tabId, reason = "evicted") {
  if (!Number.isFinite(tabId)) return false
  if (!pendingByTab.has(tabId)) return false
  pendingByTab.delete(tabId)
  if (reason === "paused") {
    bumpActivity("seekPredictionPausedEvicted", 1)
  } else if (reason === "scrub") {
    bumpActivity("seekPredictionScrubEvicted", 1)
  } else if (reason === "expired") {
    bumpActivity("seekPredictionExpired", 1)
  }
  return true
}

function invalidateSeekPredictionsForScrub(tabId) {
  return evictSeekPredictionPending(tabId, "scrub")
}

function notePlayerPausedForSeekPrediction(tabId) {
  evictSeekPredictionPending(tabId, "paused")
}

function resolveSeekPredictionActual(tabId, actualIndex, options = {}) {
  if (!Number.isFinite(tabId) || typeof actualIndex !== "number") return null
  const pending = pendingByTab.get(tabId)
  if (!pending) return null

  const now = Date.now()
  if (pending.frozen === true) {
    pendingByTab.delete(tabId)
    bumpActivity("seekPredictionPausedEvicted", 1)
    return null
  }

  if (now - pending.at > RESOLVE_WINDOW_MS) {
    evictSeekPredictionPending(tabId, "expired")
    return null
  }

  const actual = Math.round(actualIndex)
  const predicted = pending.predictedIndex
  const error = Math.abs(actual - predicted)
  const signedError = actual - predicted
  const accuracyScore = gaussianAccuracyScore(error)

  pendingByTab.delete(tabId)
  errorSamples.push(error)
  gaussianScores.push(accuracyScore)
  if (errorSamples.length > MAX_ERROR_SAMPLES) {
    errorSamples.splice(0, errorSamples.length - MAX_ERROR_SAMPLES)
  }
  if (gaussianScores.length > MAX_ERROR_SAMPLES) {
    gaussianScores.splice(0, gaussianScores.length - MAX_ERROR_SAMPLES)
  }

  resolvedCount += 1
  if (error <= 3) hitWithin3Count += 1
  blendConfidence(accuracyScore)
  bumpActivity("seekPredictionResolved", 1)
  if (error <= 3) bumpActivity("seekPredictionWithin3", 1)
  if (error <= 1) bumpActivity("seekPredictionWithin1", 1)

  const source = options.source || "player-segment"
  const logLevel = accuracyScore >= 0.3 ? "INFO" : "WARN"
  addLog(
    logLevel,
    `Seek prediction resolved (${source}, tab ${tabId}): prediction=${predicted}, actual=${actual}, error=${error}${signedError !== 0 ? ` (${signedError > 0 ? "+" : ""}${signedError})` : ""}, gaussian=${accuracyScore.toFixed(2)}`
  )

  maybeLogSeekPredictionSummary(false)

  return {
    predicted,
    actual,
    error,
    signedError,
    accuracyScore,
    currentTimeSec: pending.currentTimeSec
  }
}

function getPredictionConfidence() {
  const minSamples = Math.max(4, Number(ns.constants?.SEEK_PREDICTION_MIN_SAMPLES) || 8)
  if (resolvedCount < minSamples) return 0.5
  const linear = hitWithin3Count / resolvedCount
  const gaussianMean =
    gaussianScores.length > 0
      ? gaussianScores.reduce((acc, value) => acc + value, 0) / gaussianScores.length
      : linear
  const blended = Math.min(linear, penalizedConfidence, gaussianMean)
  return Math.round(blended * 1000) / 1000
}

function getPredictionHitRate() {
  if (resolvedCount === 0) return 0
  return Math.round((hitWithin3Count / resolvedCount) * 1000) / 1000
}

function isSeekPredictionEnabled() {
  const disableBelow =
    Number(ns.constants?.SEEK_PREDICTION_DISABLE_THRESHOLD) || 0.35
  return getPredictionConfidence() >= disableBelow
}

function isSpeculativePredictionEnabled() {
  const enableAbove =
    Number(ns.constants?.SEEK_PREDICTION_SPECULATIVE_THRESHOLD) || 0.75
  return getPredictionConfidence() >= enableAbove
}

function getSeekPredictionSummary() {
  const samples = errorSamples.length
  const confidence = getPredictionConfidence()
  const hitRate = getPredictionHitRate()
  const enabled = isSeekPredictionEnabled()
  const speculative = isSpeculativePredictionEnabled()
  if (samples === 0) {
    return {
      samples: 0,
      meanError: 0,
      p95Error: 0,
      pending: pendingByTab.size,
      confidence,
      hitRate,
      enabled,
      speculative
    }
  }
  const sum = errorSamples.reduce((acc, value) => acc + value, 0)
  return {
    samples,
    meanError: Math.round((sum / samples) * 100) / 100,
    p95Error: computePercentile(errorSamples, 95),
    pending: pendingByTab.size,
    confidence,
    hitRate,
    enabled,
    speculative
  }
}

function maybeLogSeekPredictionSummary(force = false) {
  const summary = getSeekPredictionSummary()
  if (summary.samples === 0 && summary.pending === 0) return
  const now = Date.now()
  if (!force && now - lastSummaryLogAt < SUMMARY_LOG_INTERVAL_MS) return
  lastSummaryLogAt = now
  const confPct = Math.round((summary.confidence || 0) * 100)
  const hitPct = Math.round((summary.hitRate || 0) * 100)
  addLog(
    "INFO",
    `Seek prediction accuracy — samples=${summary.samples}, meanError=${summary.meanError}, p95Error=${summary.p95Error}, confidence=${confPct}%, hitRate=${hitPct}%, predictor=${summary.enabled ? "ON" : "OFF"}, speculative=${summary.speculative ? "ON" : "OFF"}, pending=${summary.pending}`
  )
}

function resetSeekPredictionTelemetry() {
  pendingByTab.clear()
  errorSamples.length = 0
  gaussianScores.length = 0
  lastSummaryLogAt = 0
  resolvedCount = 0
  hitWithin3Count = 0
  penalizedConfidence = 0.5
}

ns.recordSeekPrediction = recordSeekPrediction
ns.resolveSeekPredictionActual = resolveSeekPredictionActual
ns.evictSeekPredictionPending = evictSeekPredictionPending
ns.invalidateSeekPredictionsForScrub = invalidateSeekPredictionsForScrub
ns.notePlayerPausedForSeekPrediction = notePlayerPausedForSeekPrediction
ns.getSeekPredictionSummary = getSeekPredictionSummary
ns.getPredictionConfidence = getPredictionConfidence
ns.getPredictionHitRate = getPredictionHitRate
ns.isSeekPredictionEnabled = isSeekPredictionEnabled
ns.isSpeculativePredictionEnabled = isSpeculativePredictionEnabled
ns.maybeLogSeekPredictionSummary = maybeLogSeekPredictionSummary
ns.resetSeekPredictionTelemetry = resetSeekPredictionTelemetry
})()
