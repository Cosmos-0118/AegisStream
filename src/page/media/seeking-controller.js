(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("seeking-controller")) return

const { notifyRuntime, logBridge } = ns

const TRAIN_COOLDOWN_MS = 800
const TRAIN_IDLE_MS = 1_000
const MIN_DEBOUNCE_MS = 30
const MAX_DEBOUNCE_MS = 150
const INDEX_SAMPLE_MAX = 6
const VELOCITY_LOOKAHEAD_MS = 400
const VELOCITY_MIN_SEG_PER_SEC = 0.5
const VELOCITY_PREWARM_MIN_MS = 120

const FLAG_SCRUB = 1
const FLAG_RELEASE = 2
const FLAG_TRAIN_END = 4

const controllersByVideo = new WeakMap()

function formatSeekWire(fields) {
  const {
    timeSec,
    estimatedIndex,
    velocitySegPerSec,
    velocityPredictedIndex,
    currentIndex,
    isScrubbing,
    isRelease,
    scrubTrainEnded,
    timestamp
  } = fields
  let flags = 0
  if (isScrubbing) flags |= FLAG_SCRUB
  if (isRelease) flags |= FLAG_RELEASE
  if (scrubTrainEnded) flags |= FLAG_TRAIN_END
  const est =
    typeof estimatedIndex === "number" && estimatedIndex >= 0
      ? String(Math.round(estimatedIndex))
      : ""
  const vel = Number.isFinite(velocitySegPerSec) ? velocitySegPerSec.toFixed(2) : ""
  const pred =
    typeof velocityPredictedIndex === "number" && velocityPredictedIndex >= 0
      ? String(Math.round(velocityPredictedIndex))
      : ""
  const cur = typeof currentIndex === "number" && currentIndex >= 0 ? String(Math.round(currentIndex)) : ""
  return [
    Number(timeSec).toFixed(3),
    est,
    vel,
    pred,
    cur,
    String(flags),
    String(Math.round(Number(timestamp) || performance.now()))
  ].join("|")
}

function resolveManifestMapper() {
  const hint = ns.playbackManifestHint
  if (!hint || typeof ns.estimateManifestIndexFromTime !== "function") {
    return null
  }
  return {
    getSegmentIndexFromTime(currentTimeSec) {
      return ns.estimateManifestIndexFromTime(currentTimeSec, hint.segmentDurations, {
        totalDurationSec: hint.totalDuration,
        segmentCount: hint.segmentCount,
        fallbackSegmentDurationSec: 4
      })
    }
  }
}

function computeDebounceMs(timeVelocitySecPerMs) {
  const secPerMs = Number(timeVelocitySecPerMs)
  if (!Number.isFinite(secPerMs) || secPerMs <= 0) return MIN_DEBOUNCE_MS
  return Math.min(MAX_DEBOUNCE_MS, Math.max(MIN_DEBOUNCE_MS, secPerMs * 2000))
}

function computeSegmentVelocity(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const dtSec = (last.t - first.t) / 1000
  if (dtSec <= 0.05) return null
  const velocity = (last.index - first.index) / dtSec
  if (!Number.isFinite(velocity) || Math.abs(velocity) < VELOCITY_MIN_SEG_PER_SEC) {
    return null
  }
  return { velocity, lastIndex: last.index }
}

class SeekingController {
  constructor(video) {
    this.video = video
    this.lastTimeSec = Number(video.currentTime) || 0
    this.lastTimestamp = performance.now()
    this.timeVelocitySecPerMs = 0
    this.scrubTrainActive = false
    this.trainTimeoutTimer = null
    this.flushTimer = null
    this.indexSamples = []
    this.lastVelocityPrewarmAt = 0
    this.lastPrearmedPredictedIndex = null
    this.lastSeekAt = 0

    this.handleSeeking = this.handleSeeking.bind(this)
    this.handleSeeked = this.handleSeeked.bind(this)
    this.handlePause = this.handlePause.bind(this)
    this.terminateScrubTrain = this.terminateScrubTrain.bind(this)
    this.emitPayload = this.emitPayload.bind(this)

    video.addEventListener("seeking", this.handleSeeking, { passive: true })
    video.addEventListener("seeked", this.handleSeeked, { passive: true })
    video.addEventListener("pause", this.handlePause, { passive: true })
  }

  destroy() {
    this.video.removeEventListener("seeking", this.handleSeeking)
    this.video.removeEventListener("seeked", this.handleSeeked)
    this.video.removeEventListener("pause", this.handlePause)
    clearTimeout(this.trainTimeoutTimer)
    clearTimeout(this.flushTimer)
  }

  handlePause() {
    notifyRuntime("PLAYER_PAUSED", { timeSec: Number(this.video.currentTime) })
  }

  handleSeeking() {
    if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
    const now = performance.now()
    const currentTime = Number(this.video.currentTime)
    if (!Number.isFinite(currentTime)) return

    const dt = now - this.lastTimestamp
    if (dt > 0) {
      const dx = Math.abs(currentTime - this.lastTimeSec)
      this.timeVelocitySecPerMs = dx / dt
    }

    const wallNow = Date.now()
    const mapper = resolveManifestMapper()
    if (mapper) {
      const index = mapper.getSegmentIndexFromTime(currentTime)
      if (typeof index === "number" && index >= 0) {
        this.indexSamples.push({ index, t: wallNow })
        if (this.indexSamples.length > INDEX_SAMPLE_MAX) {
          this.indexSamples.shift()
        }
      }
    }

    if (this.lastSeekAt > 0 && wallNow - this.lastSeekAt < TRAIN_COOLDOWN_MS) {
      if (!this.scrubTrainActive) {
        this.scrubTrainActive = true
        logBridge?.("Scrubbing train active (rapid seeking)", "DEBUG")
      }
    }

    this.lastSeekAt = wallNow
    clearTimeout(this.trainTimeoutTimer)
    this.trainTimeoutTimer = setTimeout(this.terminateScrubTrain, TRAIN_IDLE_MS)

    const debounceMs = computeDebounceMs(this.timeVelocitySecPerMs)
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => this.emitPayload(false), debounceMs)

    this.lastTimeSec = currentTime
    this.lastTimestamp = now
  }

  handleSeeked() {
    if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
    clearTimeout(this.flushTimer)
    this.emitPayload(true)
  }

  terminateScrubTrain() {
    this.trainTimeoutTimer = null
    if (!this.scrubTrainActive) return
    this.scrubTrainActive = false
    this.indexSamples = []
    this.lastVelocityPrewarmAt = 0
    this.lastPrearmedPredictedIndex = null
    logBridge?.("Scrubbing train idle", "DEBUG")
    this.emitPayload(false, true)
  }

  buildVelocityPayload(estimatedIndex) {
    const kinematics = computeSegmentVelocity(this.indexSamples)
    if (!kinematics) return {}
    const wallNow = Date.now()
    if (wallNow - this.lastVelocityPrewarmAt < VELOCITY_PREWARM_MIN_MS) {
      return { velocitySegPerSec: kinematics.velocity }
    }
    const lookaheadSec = VELOCITY_LOOKAHEAD_MS / 1000
    const predictedIndex = Math.round(kinematics.lastIndex + kinematics.velocity * lookaheadSec)
    if (predictedIndex === this.lastPrearmedPredictedIndex) {
      return { velocitySegPerSec: kinematics.velocity }
    }
    this.lastVelocityPrewarmAt = wallNow
    this.lastPrearmedPredictedIndex = predictedIndex
    logBridge?.(
      `Scrub velocity prewarm: index ${kinematics.lastIndex} -> ${predictedIndex} (${kinematics.velocity.toFixed(1)} seg/s)`,
      "DEBUG"
    )
    return {
      velocitySegPerSec: kinematics.velocity,
      velocityPredictedIndex: predictedIndex,
      currentIndex: typeof estimatedIndex === "number" ? estimatedIndex : kinematics.lastIndex
    }
  }

  emitPayload(isRelease, scrubTrainEnded = false) {
    if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
    const currentTime = Number(this.video.currentTime)
    if (!Number.isFinite(currentTime)) return

    const mapper = resolveManifestMapper()
    let estimatedIndex = null
    if (mapper) {
      estimatedIndex = mapper.getSegmentIndexFromTime(currentTime)
    }

    const velocityFields =
      this.scrubTrainActive && !scrubTrainEnded
        ? this.buildVelocityPayload(estimatedIndex)
        : {}

    const wire = formatSeekWire({
      timeSec: currentTime,
      estimatedIndex: typeof estimatedIndex === "number" ? estimatedIndex : null,
      velocitySegPerSec: velocityFields.velocitySegPerSec,
      velocityPredictedIndex: velocityFields.velocityPredictedIndex,
      currentIndex: velocityFields.currentIndex,
      isScrubbing: this.scrubTrainActive === true && scrubTrainEnded !== true,
      isRelease: isRelease === true,
      scrubTrainEnded: scrubTrainEnded === true,
      timestamp: performance.now()
    })

    notifyRuntime("UNIFIED_SEEK_STATE", { wire })
  }
}

function setupSeekingController(video) {
  if (!(video instanceof HTMLMediaElement) || video.__aegisSeekingController) return
  video.__aegisSeekingController = true
  controllersByVideo.set(video, new SeekingController(video))
}

function observeVideosForSeeking() {
  document.querySelectorAll("video").forEach(setupSeekingController)
}

function startSeekingController() {
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return
  observeVideosForSeeking()
  const root = document.documentElement || document.body
  if (root) {
    const observer = new MutationObserver(() => observeVideosForSeeking())
    observer.observe(root, { childList: true, subtree: true })
  }
}

ns.setupSeekingController = setupSeekingController

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startSeekingController, { once: true })
} else {
  startSeekingController()
}
})()
