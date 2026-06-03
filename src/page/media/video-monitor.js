(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("video-monitor")) return

const { notifyRuntime, logBridge } = ns

const TELEPORT_DEBOUNCE_MS = 40
const SCRUB_SEEK_INTERVAL_MS = 800
const SCRUB_IDLE_MS = 1_000

const lastTeleportAtByVideo = new WeakMap()
const scrubStateByVideo = new WeakMap()

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
    idleTimer: null
  }
  if (state.active === active) {
    scrubStateByVideo.set(video, state)
    return
  }
  state.active = active
  scrubStateByVideo.set(video, state)
  notifyRuntime("SCRUBBING_TRAIN", { active })
  logBridge?.(
    active ? "Scrubbing train active (rapid seeking)" : "Scrubbing train idle",
    "DEBUG"
  )
}

function noteSeekingForScrubTrain(video) {
  if (!(video instanceof HTMLMediaElement)) return
  const now = Date.now()
  let state = scrubStateByVideo.get(video)
  if (!state) {
    state = { active: false, lastSeekAt: 0, idleTimer: null }
    scrubStateByVideo.set(video, state)
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

function startVideoAnchorMonitor() {
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return
  observeVideosForAnchorBridge()
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
