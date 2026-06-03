(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("buffer-health")) return

const { notifyRuntime, logBridge } = ns

const SAMPLE_INTERVAL_MS = 750
const TARGET_RUNWAY_SEC = 60
const STALL_WINDOW_MS = 30_000

const TIER_EMERGENCY = "emergency"
const TIER_AGGRESSIVE = "aggressive"
const TIER_NORMAL = "normal"
const TIER_MAINTENANCE = "maintenance"
const TIER_IDLE = "idle"

let lastSample = null
let lastReportedTier = null
let lastReportedScore = null
let samplesSinceReport = 0
const recentStalls = []

function recordStall(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 120) return
  recentStalls.push({ at: Date.now(), durationMs })
  const cutoff = Date.now() - STALL_WINDOW_MS
  while (recentStalls.length > 0 && recentStalls[0].at < cutoff) {
    recentStalls.shift()
  }
}

function recentStallPenaltyMs() {
  const cutoff = Date.now() - STALL_WINDOW_MS
  let total = 0
  for (const entry of recentStalls) {
    if (entry.at >= cutoff) total += entry.durationMs
  }
  return total
}

function measurePrimaryVideo() {
  const videos = document.querySelectorAll("video")
  let best = null

  for (const video of videos) {
    if (!(video instanceof HTMLMediaElement)) continue
    if (video.readyState < 1) continue

    const currentTime = Number(video.currentTime)
    if (!Number.isFinite(currentTime)) continue

    let bufferedEnd = 0
    for (let i = 0; i < video.buffered.length; i += 1) {
      const end = video.buffered.end(i)
      if (end > bufferedEnd) bufferedEnd = end
    }

    const runway = Math.max(0, bufferedEnd - currentTime)
    const candidate = {
      runway,
      bufferedEnd,
      currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused,
      playbackRate: Number(video.playbackRate) || 1,
      waiting: video.readyState < 3 && !video.paused && !video.ended
    }

    if (!best || candidate.runway < best.runway) {
      best = candidate
    }
  }

  return best
}

function computeNetFillRate(runwaySec, paused, now) {
  if (!lastSample || paused) return null
  const dtSec = (now - lastSample.at) / 1000
  if (!Number.isFinite(dtSec) || dtSec < 0.2) return null
  const playbackRate = lastSample.playbackRate || 1
  // Runway change per wall second while playing ≈ fillRate - consumption
  const runwayDelta = runwaySec - lastSample.runwaySec
  return runwayDelta / dtSec + playbackRate
}

function computeHealthScore(runwaySec, netFillRate, paused) {
  const runwayPct = Math.min(100, (runwaySec / TARGET_RUNWAY_SEC) * 100)

  let fillPct = 55
  if (!paused && netFillRate !== null) {
    fillPct = Math.min(100, Math.max(0, ((netFillRate - 0.35) / 1.15) * 100))
  } else if (paused) {
    fillPct = 70
  }

  const stallPenalty = Math.min(35, recentStallPenaltyMs() / 250)
  const raw = 0.55 * runwayPct + 0.35 * fillPct + 10 - stallPenalty
  return Math.min(100, Math.max(0, Math.round(raw)))
}

function classifyTier(runwaySec, healthScore) {
  if (runwaySec < 5 || healthScore < 22) return TIER_EMERGENCY
  if (runwaySec < 15 || healthScore < 42) return TIER_AGGRESSIVE
  if (runwaySec < 30) return TIER_NORMAL
  if (runwaySec < 60) return TIER_MAINTENANCE
  return TIER_IDLE
}

function shouldReportNow(tier, healthScore) {
  samplesSinceReport += 1
  if (tier === TIER_EMERGENCY) return true
  if (lastReportedTier !== tier) return true
  if (
    lastReportedScore !== null &&
    Math.abs(healthScore - lastReportedScore) >= 8
  ) {
    return true
  }
  return samplesSinceReport >= 5
}

function publishBufferState(state) {
  ns.bufferRunwaySec = state.runwaySec
  ns.bufferHealthScore = state.healthScore
  ns.bufferTier = state.tier
  ns.bufferNetFillRate = state.netFillRate
  ns.bufferRunwayPct = state.runwayPct

  lastReportedTier = state.tier
  lastReportedScore = state.healthScore
  samplesSinceReport = 0

  notifyRuntime("RUNTIME_METRIC", {
    metricType: "buffer_health",
    runwaySec: state.runwaySec,
    runwayPct: state.runwayPct,
    healthScore: state.healthScore,
    tier: state.tier,
    netFillRate: state.netFillRate,
    paused: state.paused,
    pageUrl: location.href
  })
}

function tick() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return
  }

  const video = measurePrimaryVideo()
  if (!video) return

  const now = Date.now()
  const runwaySec = Math.round(video.runway * 10) / 10
  const netFillRate = computeNetFillRate(runwaySec, video.paused, now)
  const healthScore = computeHealthScore(runwaySec, netFillRate, video.paused)
  const tier = classifyTier(runwaySec, healthScore)
  const runwayPct = Math.min(100, Math.round((runwaySec / TARGET_RUNWAY_SEC) * 100))

  const state = {
    runwaySec,
    runwayPct,
    healthScore,
    tier,
    netFillRate: netFillRate !== null ? Math.round(netFillRate * 100) / 100 : null,
    paused: video.paused
  }

  lastSample = {
    at: now,
    runwaySec,
    playbackRate: video.playbackRate
  }

  if (!shouldReportNow(tier, healthScore)) {
    ns.bufferRunwaySec = runwaySec
    ns.bufferHealthScore = healthScore
    ns.bufferTier = tier
    ns.bufferNetFillRate = state.netFillRate
    ns.bufferRunwayPct = runwayPct
    return
  }

  if (lastReportedTier !== tier) {
    logBridge(
      `Buffer ${tier} (runway=${runwaySec}s, health=${healthScore}%, fill=${state.netFillRate ?? "n/a"})`,
      tier === TIER_EMERGENCY ? "WARN" : "DEBUG"
    )
  }

  publishBufferState(state)
}

function attachStallObserver(video) {
  if (!(video instanceof HTMLMediaElement) || video.__aegisBufferStallHook) return
  video.__aegisBufferStallHook = true
  let waitingSince = null

  video.addEventListener("waiting", () => {
    if (video.paused || video.ended) return
    waitingSince = performance.now()
  })

  const endWait = () => {
    if (waitingSince === null) return
    const durationMs = performance.now() - waitingSince
    waitingSince = null
    recordStall(durationMs)
  }

  video.addEventListener("playing", endWait)
  video.addEventListener("canplay", endWait)
  video.addEventListener("seeked", endWait)
  video.addEventListener("pause", () => {
    waitingSince = null
  })
}

function observeVideos() {
  document.querySelectorAll("video").forEach(attachStallObserver)
}

function startBufferHealthMonitor() {
  observeVideos()
  const observer = new MutationObserver(() => observeVideos())
  const root = document.documentElement || document.body
  if (root) {
    observer.observe(root, { childList: true, subtree: true })
  }

  tick()
  setInterval(tick, SAMPLE_INTERVAL_MS)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick()
  })
  logBridge("Buffer health monitor started (750ms, score-based)", "DEBUG")
}

ns.recordBufferStall = recordStall

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startBufferHealthMonitor, { once: true })
} else {
  startBufferHealthMonitor()
}

ns.measurePrimaryVideoRunway = () => {
  const v = measurePrimaryVideo()
  return v ? v.runway : null
}
ns.TIER_EMERGENCY = TIER_EMERGENCY
ns.TIER_AGGRESSIVE = TIER_AGGRESSIVE
ns.TIER_NORMAL = TIER_NORMAL
ns.TIER_MAINTENANCE = TIER_MAINTENANCE
ns.TIER_IDLE = TIER_IDLE
})()
