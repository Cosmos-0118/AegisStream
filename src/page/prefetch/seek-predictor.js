(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("seek-predictor")) return

const { notifyRuntime } = ns

const SEEK_PREDICT_DEBOUNCE_MS = 80
let lastPredictAt = 0

function publishSeekPrediction(video) {
  if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
  if (!(video instanceof HTMLMediaElement)) return
  const now = Date.now()
  if (now - lastPredictAt < SEEK_PREDICT_DEBOUNCE_MS) return
  lastPredictAt = now

  const currentTime = Number(video.currentTime)
  const duration = Number.isFinite(video.duration) ? Number(video.duration) : null
  if (!Number.isFinite(currentTime)) return

  notifyRuntime("RUNTIME_METRIC", {
    metricType: "seek_prediction",
    currentTime,
    duration
  })
}

function attachSeekPredictor(video) {
  if (!(video instanceof HTMLMediaElement) || video.__aegisSeekPredictHook) return
  video.__aegisSeekPredictHook = true
  video.addEventListener("seeking", () => publishSeekPrediction(video), { passive: true })
}

function observeVideosForSeekPrediction() {
  document.querySelectorAll("video").forEach(attachSeekPredictor)
}

function startSeekPredictor() {
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return
  observeVideosForSeekPrediction()
  const root = document.documentElement || document.body
  if (root) {
    const observer = new MutationObserver(() => observeVideosForSeekPrediction())
    observer.observe(root, { childList: true, subtree: true })
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startSeekPredictor, { once: true })
} else {
  startSeekPredictor()
}
})()
