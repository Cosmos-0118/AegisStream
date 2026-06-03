(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("buffer-health")) return

const { notifyRuntime, logBridge } = ns

const SAMPLE_INTERVAL_MS = 750
const DEFAULT_TARGET_RUNWAY_SEC = 60
const DEFAULT_COMFORT_RUNWAY_SEC = 45

function getTargetRunwaySec() {
  const configured = Number(ns.bufferTargetRunwaySec)
  if (Number.isFinite(configured) && configured > 0) return configured
  return DEFAULT_TARGET_RUNWAY_SEC
}

function getComfortRunwaySec() {
  const target = getTargetRunwaySec()
  if (target <= DEFAULT_TARGET_RUNWAY_SEC) return DEFAULT_COMFORT_RUNWAY_SEC
  return Math.round(target * (DEFAULT_COMFORT_RUNWAY_SEC / DEFAULT_TARGET_RUNWAY_SEC))
}
const STALL_WINDOW_MS = 30_000

const TIER_EMERGENCY = "emergency"
const TIER_AGGRESSIVE = "aggressive"
const TIER_NORMAL = "normal"
const TIER_MAINTENANCE = "maintenance"
const TIER_IDLE = "idle"
const SEEK_IDLE_MS_DEFAULT = 450
const SEEK_IDLE_MS_TOUCH = 550

function resolveSeekIdleMs() {
  try {
    if (window.matchMedia?.("(pointer: coarse)").matches) return SEEK_IDLE_MS_TOUCH
  } catch {
    // ignore
  }
  return SEEK_IDLE_MS_DEFAULT
}

let lastSample = null
let lastSeekEventAt = 0
let seekActivityActive = false
let seekSettleTimer = null
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

function runwayAtPlayhead(video) {
  const currentTime = Number(video.currentTime)
  if (!Number.isFinite(currentTime)) return { runway: 0, bufferedEnd: 0 }

  for (let i = 0; i < video.buffered.length; i += 1) {
    const start = video.buffered.start(i)
    const end = video.buffered.end(i)
    if (currentTime >= start && currentTime <= end) {
      return { runway: Math.max(0, end - currentTime), bufferedEnd: end }
    }
  }

  return { runway: 0, bufferedEnd: 0 }
}

function measurePrimaryVideo() {
  const videos = document.querySelectorAll("video")
  let best = null

  for (const video of videos) {
    if (!(video instanceof HTMLMediaElement)) continue
    if (video.readyState < 1) continue

    const currentTime = Number(video.currentTime)
    if (!Number.isFinite(currentTime)) continue

    const { runway, bufferedEnd } = runwayAtPlayhead(video)
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

function computeHealthScore(runwaySec, netFillRate, paused, playbackRate = 1) {
  const targetRunwaySec = getTargetRunwaySec()
  const comfortRunwaySec = getComfortRunwaySec()
  const runwayPct = Math.min(100, (runwaySec / targetRunwaySec) * 100)
  const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1

  let fillPct = 55
  if (paused) {
    fillPct = runwaySec >= comfortRunwaySec ? 90 : 70
  } else if (netFillRate !== null) {
    if (runwaySec >= comfortRunwaySec) {
      // Plenty of runway — steady lead or slow drain is healthy, not a crisis.
      if (netFillRate >= rate * 0.85) {
        fillPct = 95
      } else if (netFillRate >= 0) {
        fillPct = 88
      } else {
        fillPct = Math.min(100, Math.max(50, ((netFillRate - 0.35) / 1.15) * 100))
      }
    } else {
      fillPct = Math.min(100, Math.max(0, ((netFillRate - 0.35) / 1.15) * 100))
    }
  }

  const stallPenalty = Math.min(35, recentStallPenaltyMs() / 250)
  const raw = 0.55 * runwayPct + 0.35 * fillPct + 10 - stallPenalty
  return Math.min(100, Math.max(0, Math.round(raw)))
}

function isSeekSettling() {
  if (seekActivityActive) return true
  return Date.now() - lastSeekEventAt < resolveSeekIdleMs()
}

function bumpSeekActivity() {
  const idleMs = resolveSeekIdleMs()
  lastSeekEventAt = Date.now()
  seekActivityActive = true
  if (seekSettleTimer) clearTimeout(seekSettleTimer)
  seekSettleTimer = setTimeout(() => {
    seekSettleTimer = null
    if (Date.now() - lastSeekEventAt >= idleMs) {
      seekActivityActive = false
    }
  }, idleMs)
}

function classifyTier(runwaySec, healthScore) {
  // Do not mark emergency/aggressive from fill-rate noise when runway is already ample.
  const healthEmergency = healthScore < 22 && runwaySec < 20
  const healthAggressive = healthScore < 42 && runwaySec < Math.min(getComfortRunwaySec(), 25)
  let tier
  if (runwaySec < 5 || healthEmergency) tier = TIER_EMERGENCY
  else if (runwaySec < 15 || healthAggressive) tier = TIER_AGGRESSIVE
  else if (runwaySec < 30) tier = TIER_NORMAL
  else if (runwaySec < 60) tier = TIER_MAINTENANCE
  else tier = TIER_IDLE

  if (isSeekSettling() && (tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE)) {
    return TIER_MAINTENANCE
  }
  return tier
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
  if (ns.extensionEnabled === false) return
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    return
  }

  const video = measurePrimaryVideo()
  if (!video) return

  const now = Date.now()
  const runwaySec = Math.round(video.runway * 10) / 10
  const netFillRate = computeNetFillRate(runwaySec, video.paused, now)
  const healthScore = computeHealthScore(runwaySec, netFillRate, video.paused, video.playbackRate)
  const tier = classifyTier(runwaySec, healthScore)
  const runwayPct = Math.min(100, Math.round((runwaySec / getTargetRunwaySec()) * 100))

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

function noteSeekActivity() {
  bumpSeekActivity()
}

function attachStallObserver(video) {
  if (!(video instanceof HTMLMediaElement) || video.__aegisBufferStallHook) return
  video.__aegisBufferStallHook = true
  let waitingSince = null

  video.addEventListener("seeking", noteSeekActivity)
  video.addEventListener("seeked", noteSeekActivity)

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
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) {
    logBridge("Buffer health monitor skipped (Twitch reactive passthrough)", "DEBUG")
    return
  }
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
ns.runwayAtPlayhead = runwayAtPlayhead
ns.computeHealthScore = computeHealthScore
ns.classifyTier = classifyTier
ns.TIER_EMERGENCY = TIER_EMERGENCY
ns.TIER_AGGRESSIVE = TIER_AGGRESSIVE
ns.TIER_NORMAL = TIER_NORMAL
ns.TIER_MAINTENANCE = TIER_MAINTENANCE
ns.TIER_IDLE = TIER_IDLE
})()
