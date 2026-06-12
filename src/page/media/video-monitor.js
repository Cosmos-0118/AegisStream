(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("video-monitor")) return

const { notifyRuntime, logBridge } = ns

const TELEPORT_DEBOUNCE_MS = 40
const WORKER_LIVELINESS_PING_MS = 10_000

const lastTeleportAtByVideo = new WeakMap()

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

function broadcastForceTeleport(video, manifestMapper, eventType = "seeked") {
  if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
  if (!(video instanceof HTMLMediaElement)) return

  const now = Date.now()
  const lastAt = lastTeleportAtByVideo.get(video) || 0
  if (now - lastAt < TELEPORT_DEBOUNCE_MS) return
  lastTeleportAtByVideo.set(video, now)

  const currentTime = Number(video.currentTime)
  if (!Number.isFinite(currentTime)) return

  const graceUntil = Number(ns.variantSwitchGraceUntil || 0)
  const retainedAnchor = ns.variantSwitchAnchorIndex
  if (
    graceUntil > Date.now() &&
    typeof retainedAnchor === "number"
  ) {
    const suppressSec = Number(ns.variantSwitchTeleportSuppressSec) || 20
    const mapper = manifestMapper || resolveManifestMapper()
    let mappedIndex = null
    if (mapper && typeof mapper.getSegmentIndexFromTime === "function") {
      mappedIndex = mapper.getSegmentIndexFromTime(currentTime)
    }
    if (typeof mappedIndex === "number" && mappedIndex < retainedAnchor - 2) {
      if (currentTime < suppressSec || mappedIndex < retainedAnchor - 4) {
        logBridge?.(
          `Skipped variant-switch DOM teleport at ${currentTime.toFixed(2)}s (mapped ${mappedIndex}, retained ${retainedAnchor})`,
          "DEBUG"
        )
        return
      }
    }
  }

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
  if (typeof ns.activateMediaBridge === "function") {
    ns.activateMediaBridge("video-detected")
  }
  videoElement.__aegisAnchorBridgeHook = true

  const mapper = manifestMapper || resolveManifestMapper()
  if (typeof ns.setupSeekingController === "function") {
    ns.setupSeekingController(videoElement)
  }
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
      logBridge?.("Tab hidden — pausing new prefetch (in-flight retained)", "DEBUG")
      return
    }
    notifyRuntime("TAB_VISIBILITY_RESUME", { hidden: false })
    logBridge?.("Tab visible — re-warming buffer pipelines", "DEBUG")
    if (typeof ns.requestBufferHealthTick === "function") {
      ns.requestBufferHealthTick("visibility-resume")
    }
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
