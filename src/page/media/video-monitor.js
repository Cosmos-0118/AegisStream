(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("video-monitor")) return

const { notifyRuntime, logBridge } = ns

const TELEPORT_DEBOUNCE_MS = 40
const SCRUB_SEEK_INTERVAL_MS = 800
const SCRUB_IDLE_MS = 1_000
const WORKER_LIVELINESS_PING_MS = 10_000

const lastTeleportAtByVideo = new WeakMap()
const scrubStateByVideo = new WeakMap()
const SCRUB_VELOCITY_SAMPLE_MAX = 6
const SCRUB_VELOCITY_LOOKAHEAD_MS = 400
const SCRUB_VELOCITY_MIN_SEG_PER_SEC = 0.5

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

function setScrubbingTrainActive(video, active) {
  const state = scrubStateByVideo.get(video) || {
    active: false,
    lastSeekAt: 0,
    idleTimer: null,
    indexSamples: [],
    lastVelocityPrewarmAt: 0
  }
  if (state.active === active) {
    scrubStateByVideo.set(video, state)
    return
  }
  state.active = active
  if (!active) {
    state.indexSamples = []
    state.lastVelocityPrewarmAt = 0
    state.lastPrearmedPredictedIndex = null
  }
  scrubStateByVideo.set(video, state)
  notifyRuntime("SCRUBBING_TRAIN", { active })
  logBridge?.(
    active ? "Scrubbing train active (rapid seeking)" : "Scrubbing train idle",
    "DEBUG"
  )
}

function maybePrewarmFromScrubVelocity(video, mapper) {
  if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
  const state = scrubStateByVideo.get(video)
  if (!state?.active || !Array.isArray(state.indexSamples) || state.indexSamples.length < 2) {
    return
  }
  const samples = state.indexSamples
  const first = samples[0]
  const last = samples[samples.length - 1]
  const dtSec = (last.t - first.t) / 1000
  if (dtSec <= 0.05) return
  const velocity = (last.index - first.index) / dtSec
  if (Math.abs(velocity) < SCRUB_VELOCITY_MIN_SEG_PER_SEC) return

  const lookaheadSec = SCRUB_VELOCITY_LOOKAHEAD_MS / 1000
  const predictedIndex = Math.round(last.index + velocity * lookaheadSec)
  if (predictedIndex === state.lastPrearmedPredictedIndex) return
  const now = Date.now()
  if (now - Number(state.lastVelocityPrewarmAt || 0) < 120) return
  state.lastVelocityPrewarmAt = now
  state.lastPrearmedPredictedIndex = predictedIndex

  notifyRuntime("SCRUB_VELOCITY_PREFETCH", {
    predictedIndex,
    velocitySegPerSec: velocity,
    currentIndex: last.index
  })
  logBridge?.(
    `Scrub velocity prewarm: index ${last.index} -> ${predictedIndex} (${velocity.toFixed(1)} seg/s)`,
    "DEBUG"
  )
}

function noteSeekingForScrubTrain(video) {
  if (!(video instanceof HTMLMediaElement)) return
  const now = Date.now()
  let state = scrubStateByVideo.get(video)
  if (!state) {
    state = {
      active: false,
      lastSeekAt: 0,
      idleTimer: null,
      indexSamples: [],
      lastVelocityPrewarmAt: 0
    }
    scrubStateByVideo.set(video, state)
  }

  const mapper = resolveManifestMapper()
  const currentTime = Number(video.currentTime)
  if (mapper && Number.isFinite(currentTime)) {
    const index = mapper.getSegmentIndexFromTime(currentTime)
    if (typeof index === "number" && index >= 0) {
      state.indexSamples.push({ index, t: now })
      if (state.indexSamples.length > SCRUB_VELOCITY_SAMPLE_MAX) {
        state.indexSamples.shift()
      }
      if (state.active) maybePrewarmFromScrubVelocity(video, mapper)
    }
  }

  if (state.lastSeekAt > 0 && now - state.lastSeekAt < SCRUB_SEEK_INTERVAL_MS) {
    if (!state.active) setScrubbingTrainActive(video, true)
    else notifyRuntime("SCRUBBING_TRAIN", { active: true })
  }

  state.lastSeekAt = now
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null
    if (state.active) setScrubbingTrainActive(video, false)
  }, SCRUB_IDLE_MS)
}

function broadcastForceTeleport(video, manifestMapper, eventType = "seeked") {
  if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
  if (!(video instanceof HTMLMediaElement)) return

  const now = Date.now()
  const lastAt = lastTeleportAtByVideo.get(video) || 0
  if (now - lastAt < TELEPORT_DEBOUNCE_MS) return
  lastTeleportAtByVideo.set(video, now)

  const currentTime = Number(video.currentTime)
  if (!Number.isFinite(currentTime)) return

  let targetedIndex = null
  if (manifestMapper && typeof manifestMapper.getSegmentIndexFromTime === "function") {
    targetedIndex = manifestMapper.getSegmentIndexFromTime(currentTime)
  }

  notifyRuntime("FORCE_TELEPORT_ANCHOR", {
    index: typeof targetedIndex === "number" ? targetedIndex : null,
    currentTimeSec: currentTime,
    timestamp: now,
    eventType
  })

  if (typeof targetedIndex === "number" && targetedIndex >= 0) {
    logBridge?.(
      `Native seeked at ${currentTime.toFixed(2)}s -> force teleport index ${targetedIndex}`,
      "DEBUG"
    )
  }
}

function setupVideoElementAnchorBridge(videoElement, manifestMapper) {
  if (!videoElement || videoElement.__aegisAnchorBridgeHook) return
  videoElement.__aegisAnchorBridgeHook = true

  const mapper = manifestMapper || resolveManifestMapper()
  videoElement.addEventListener("seeking", () => noteSeekingForScrubTrain(videoElement), {
    passive: true
  })
  videoElement.addEventListener(
    "seeked",
    () => broadcastForceTeleport(videoElement, mapper, "seeked"),
    { passive: true }
  )
  videoElement.addEventListener(
    "playing",
    () => {
      if (videoElement.seeking) broadcastForceTeleport(videoElement, mapper, "playing")
    },
    { passive: true }
  )
}

function observeVideosForAnchorBridge() {
  const mapper = resolveManifestMapper()
  document.querySelectorAll("video").forEach((video) => {
    setupVideoElementAnchorBridge(video, mapper)
  })
}

function isAnyVideoPlaying() {
  const videos = document.querySelectorAll("video")
  for (const video of videos) {
    if (video instanceof HTMLMediaElement && !video.paused && !video.ended) {
      return true
    }
  }
  return false
}

function startWorkerLivelinessBridge() {
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return
  setInterval(() => {
    if (ns.extensionEnabled === false) return
    if (!isAnyVideoPlaying()) return
    notifyRuntime("LIVELINESS_PING", { playing: true })
  }, WORKER_LIVELINESS_PING_MS)
}

function setupVisibilityLifecycleGuards() {
  if (typeof document === "undefined" || document.__aegisVisibilityGuard === true) return
  document.__aegisVisibilityGuard = true

  const applyVisibilityState = (hidden) => {
    ns.pageVisibilitySleep = hidden === true
    if (hidden) {
      notifyRuntime("TAB_VISIBILITY_PAUSE", { hidden: true })
      logBridge?.("Tab hidden — pausing background prefetch engine", "INFO")
      if (typeof ns.cancelPrefetchRunway === "function") {
        ns.cancelPrefetchRunway([], { reason: "visibility-pause" })
      } else if (typeof ns.cancelInflightChunkStores === "function") {
        ns.cancelInflightChunkStores("visibility-pause")
      }
      return
    }
    notifyRuntime("TAB_VISIBILITY_RESUME", { hidden: false })
    logBridge?.("Tab visible — re-warming buffer pipelines", "DEBUG")
  }

  document.addEventListener("visibilitychange", () => {
    applyVisibilityState(document.visibilityState === "hidden")
  })
  applyVisibilityState(document.visibilityState === "hidden")
}

function startVideoAnchorMonitor() {
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return
  setupVisibilityLifecycleGuards()
  observeVideosForAnchorBridge()
  startWorkerLivelinessBridge()
  const root = document.documentElement || document.body
  if (!root) return
  const observer = new MutationObserver(() => observeVideosForAnchorBridge())
  observer.observe(root, { childList: true, subtree: true })
}

ns.setupVideoElementAnchorBridge = setupVideoElementAnchorBridge

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startVideoAnchorMonitor, { once: true })
} else {
  startVideoAnchorMonitor()
}
})()
