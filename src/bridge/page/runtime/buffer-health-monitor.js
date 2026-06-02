(() => {
var ns = (self.AegisPageBridge ||= {})
if (ns.__bufferHealthMonitorInstalled === true) return
ns.__bufferHealthMonitorInstalled = true

const { notifyRuntime, logBridge } = ns

const SAMPLE_INTERVAL_MS = 2000
const MIN_RUNWAY_DELTA_SEC = 2

let lastReportedRunway = null

function measurePrimaryVideoRunway() {
  const videos = document.querySelectorAll("video")
  let bestRunway = null

  for (const video of videos) {
    if (!(video instanceof HTMLMediaElement)) continue
    if (video.readyState < 1) continue

    const currentTime = Number(video.currentTime)
    if (!Number.isFinite(currentTime)) continue

    let bufferedEnd = 0
    const ranges = video.buffered
    for (let i = 0; i < ranges.length; i += 1) {
      const end = ranges.end(i)
      if (end > bufferedEnd) bufferedEnd = end
    }

    const runway = Math.max(0, bufferedEnd - currentTime)
    if (bestRunway === null || runway < bestRunway) {
      bestRunway = runway
    }
  }

  return bestRunway
}

function reportBufferHealth(runwaySec) {
  const rounded = Math.round(runwaySec * 10) / 10
  ns.bufferRunwaySec = rounded

  if (
    lastReportedRunway !== null &&
    Math.abs(rounded - lastReportedRunway) < MIN_RUNWAY_DELTA_SEC
  ) {
    return
  }

  lastReportedRunway = rounded
  notifyRuntime("RUNTIME_METRIC", {
    metricType: "buffer_health",
    runwaySec: rounded,
    pageUrl: location.href
  })
}

function tick() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return
  }

  const runway = measurePrimaryVideoRunway()
  if (runway === null) return
  reportBufferHealth(runway)
}

function startBufferHealthMonitor() {
  tick()
  setInterval(tick, SAMPLE_INTERVAL_MS)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick()
  })
  logBridge("Buffer-aware prefetch monitor started", "DEBUG")
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startBufferHealthMonitor, { once: true })
} else {
  startBufferHealthMonitor()
}

ns.measurePrimaryVideoRunway = measurePrimaryVideoRunway
})()
