(() => {
var ns = (self.AegisBackground ||= {})
const { state, addLog, bumpActivity } = ns

const LEAK_MAX_ACTIVE_FETCHES = 20
const LEAK_MAX_CONTROLLER_AGE_MS = 60_000
const LEAK_AUDIT_INTERVAL_MS = 30_000
const LEAK_LOG_THROTTLE_MS = 60_000

const activeFetchControllers = new Map()
let leakMonitorStarted = false
let leakLogThrottleAt = 0

function isExpectedAbortError(err) {
  if (!err) return false
  if (err.name === "AbortError") return true
  return err.code === 20
}

function logUnexpectedRaceBranchError(branch, err) {
  if (isExpectedAbortError(err)) return
  const message = err?.message || String(err)
  addLog("WARN", `Extension fetch race path ${branch} failed: ${message}`)
}

function normalizeFetchSource(source) {
  if (typeof source !== "string" || !source) return "unknown"
  return source.slice(0, 48)
}

function ensureSourceBucket(source) {
  if (!state.telemetry.extensionFetchBySource) {
    state.telemetry.extensionFetchBySource = {}
  }
  const key = normalizeFetchSource(source)
  if (!state.telemetry.extensionFetchBySource[key]) {
    state.telemetry.extensionFetchBySource[key] = {
      started: 0,
      completed: 0,
      aborted: 0,
      failed: 0
    }
  }
  return state.telemetry.extensionFetchBySource[key]
}

function bumpExtensionFetchLifecycle(source, outcome) {
  const normalized = normalizeFetchSource(source)
  const bucket = ensureSourceBucket(normalized)
  if (bucket[outcome] != null) bucket[outcome] += 1

  const statKey = `extensionFetch${outcome.charAt(0).toUpperCase()}${outcome.slice(1)}`
  if (typeof state.stats[statKey] === "number") {
    state.stats[statKey] += 1
  }
  bumpActivity(statKey, 1)
}

function auditActiveExtensionFetches(trigger) {
  const now = Date.now()
  let staleCount = 0
  for (const entry of activeFetchControllers.values()) {
    const startedAt = Number(entry?.startedAt || 0)
    if (startedAt > 0 && now - startedAt > LEAK_MAX_CONTROLLER_AGE_MS) staleCount += 1
  }
  const active = activeFetchControllers.size
  if (active <= LEAK_MAX_ACTIVE_FETCHES && staleCount === 0) return
  if (now - leakLogThrottleAt < LEAK_LOG_THROTTLE_MS) return
  leakLogThrottleAt = now
  addLog(
    "WARN",
    `Possible fetch leak detected (${trigger}): active=${active}, stale>${Math.round(
      LEAK_MAX_CONTROLLER_AGE_MS / 1000
    )}s=${staleCount}`
  )
}

function registerActiveExtensionFetch(requestId, entry) {
  if (!requestId || !entry?.controller) return
  activeFetchControllers.set(requestId, {
    controller: entry.controller,
    startedAt: Number(entry.startedAt) || Date.now(),
    tabId: entry.tabId ?? null,
    source: normalizeFetchSource(entry.source)
  })
  auditActiveExtensionFetches("register")
}

function releaseActiveExtensionFetch(requestId) {
  if (!requestId) return
  activeFetchControllers.delete(requestId)
}

function abortActiveExtensionFetch(requestId) {
  const entry = activeFetchControllers.get(requestId)
  if (entry?.controller) {
    try {
      entry.controller.abort()
    } catch {
      // ignore
    }
  }
  activeFetchControllers.delete(requestId)
}

function startExtensionFetchLeakMonitor() {
  if (leakMonitorStarted) return
  leakMonitorStarted = true
  setInterval(() => auditActiveExtensionFetches("interval"), LEAK_AUDIT_INTERVAL_MS)
}

function resetExtensionFetchMetrics() {
  state.telemetry.extensionFetchBySource = {}
  activeFetchControllers.clear()
}

function summarizeExtensionFetchMetrics() {
  const totals = {
    started: Number(state.stats.extensionFetchStarted) || 0,
    completed: Number(state.stats.extensionFetchCompleted) || 0,
    aborted: Number(state.stats.extensionFetchAborted) || 0,
    failed: Number(state.stats.extensionFetchFailed) || 0
  }
  const bySource = state.telemetry.extensionFetchBySource || {}
  return { totals, bySource, activeFetches: activeFetchControllers.size }
}

function formatExtensionFetchMetricsLine() {
  const { totals, activeFetches } = summarizeExtensionFetchMetrics()
  return `ExtensionFetch: started=${totals.started}, completed=${totals.completed}, aborted=${totals.aborted}, failed=${totals.failed}, active=${activeFetches}`
}

ns.isExpectedAbortError = isExpectedAbortError
ns.logUnexpectedRaceBranchError = logUnexpectedRaceBranchError
ns.bumpExtensionFetchLifecycle = bumpExtensionFetchLifecycle
ns.registerActiveExtensionFetch = registerActiveExtensionFetch
ns.releaseActiveExtensionFetch = releaseActiveExtensionFetch
ns.abortActiveExtensionFetch = abortActiveExtensionFetch
ns.auditActiveExtensionFetches = auditActiveExtensionFetches
ns.startExtensionFetchLeakMonitor = startExtensionFetchLeakMonitor
ns.resetExtensionFetchMetrics = resetExtensionFetchMetrics
ns.summarizeExtensionFetchMetrics = summarizeExtensionFetchMetrics
ns.formatExtensionFetchMetricsLine = formatExtensionFetchMetricsLine
})()
