import { mountThemeMenu } from "./themes/theme-picker.js"

const el = {
  enabled: document.getElementById("enabled"),
  prefetchEnabled: document.getElementById("prefetchEnabled"),
  speculativePrefetchEnabled: document.getElementById("speculativePrefetchEnabled"),
  serveFromCache: document.getElementById("serveFromCache"),
  prefetchWindow: document.getElementById("prefetchWindow"),

  performancePane: document.getElementById("performance"),
  pipelineStatus: document.getElementById("pipelineStatus"),
  bfcacheEnforcerEnabled: document.getElementById("bfcacheEnforcerEnabled"),
  documentStreamBoost: document.getElementById("documentStreamBoost"),
  headerEarlyHints: document.getElementById("headerEarlyHints"),
  cpuShieldEnabled: document.getElementById("cpuShieldEnabled"),
  aggressiveScriptDefuserEnabled: document.getElementById("aggressiveScriptDefuserEnabled"),
  performanceControls: document.querySelectorAll("[data-performance-control]"),

  statHits: document.getElementById("stat-hits"),
  statMisses: document.getElementById("stat-misses"),
  statPrefetched: document.getElementById("stat-prefetched"),
  statFailures: document.getElementById("stat-failures"),
  statPlaylists: document.getElementById("stat-playlists"),
  statChunks: document.getElementById("stat-chunks"),
  statLookups: document.getElementById("stat-lookups"),
  statWarmups: document.getElementById("stat-warmups"),
  statRunway: document.getElementById("stat-runway"),
  statCacheFilled: document.getElementById("stat-cache-filled"),
  statTtfb: document.getElementById("stat-ttfb"),
  statStalls: document.getElementById("stat-stalls"),
  statEvictSuppressed: document.getElementById("stat-evict-suppressed"),
  statConsumerSaved: document.getElementById("stat-consumer-saved"),
  statSpecMode: document.getElementById("stat-spec-mode"),
  statSpecHit: document.getElementById("stat-spec-hit"),
  statSpecUsed: document.getElementById("stat-spec-used"),
  statSpecMb: document.getElementById("stat-spec-mb"),
  statSpecSwitch: document.getElementById("stat-spec-switch"),
  statHitrate: document.getElementById("stat-hitrate"),
  statHitrateBar: document.getElementById("stat-hitrate-bar"),
  
  clearCache: document.getElementById("clearCache"),
  resetStats: document.getElementById("resetStats"),
  statsScope: document.getElementById("statsScope"),
  
  globalStatusDot: document.getElementById("global-status-dot"),
  globalStatusText: document.getElementById("global-status-text"),
  
  tabBtns: document.querySelectorAll(".tab-btn"),
  tabPanes: document.querySelectorAll(".tab-pane"),
  
  logsContainer: document.getElementById("logsContainer"),
  clearLogs: document.getElementById("clearLogs"),
  copyLogs: document.getElementById("copyLogs"),
  themeMenu: document.getElementById("themeMenu"),
}

let statsPollId = null
let latestLogs = []
let statusTimer = null

const EMPTY_STATS = {
  cacheLookups: 0,
  cacheHits: 0,
  cacheMisses: 0,
  cacheWarmups: 0,
  cachedChunks: 0,
  prefetched: 0,
  prefetchFailed: 0,
  playlistsDetected: 0,
  chunksObserved: 0,
  requestFirstByteSamples: 0,
  requestFirstByteAvgMs: 0,
  requestFirstByteP95Ms: 0,
  cacheFirstByteAvgMs: 0,
  networkFirstByteAvgMs: 0,
  videoStalls: 0,
  videoStallMsTotal: 0,
  videoStallLongestMs: 0,
  cacheEntries: 0,
  activityWindowLabel: "Last 5 min",
  hitRatePercent: 0,
  chunksStoredInWindow: 0,
  cacheFillWrites: 0,
  cacheFillBytes: 0,
  bufferHealth: null,
  chunkStore: null,
  evictionSuppressedByScrub: 0,
  consumerProtectedSkips: 0
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatTime(isoString) {
  try {
    const d = new Date(isoString)
    return d.toLocaleTimeString("en-US", { hour12: false })
  } catch {
    return "--:--:--"
  }
}

function renderLogs(logs) {
  latestLogs = logs || []
  if (!latestLogs.length) {
    el.logsContainer.innerHTML = `
      <div class="log-entry info">
        <span class="log-level">INFO</span>
        <span class="log-msg">No logs yet. Browse a site with HLS/DASH streams to see activity.</span>
      </div>`
    return
  }
  
  // Check if user is scrolled to the bottom before updating
  const isAtBottom = el.logsContainer.scrollHeight - el.logsContainer.clientHeight <= el.logsContainer.scrollTop + 20
  
  let html = ''
  for (const log of latestLogs) {
    const time = formatTime(log.timestamp)
    const lvl = (log.level || "INFO").toLowerCase()
    const safeMsg = (log.message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    html += `<div class="log-entry ${lvl}"><span class="log-time">${time}</span><span class="log-level">${log.level || "INFO"}</span><span class="log-msg">${safeMsg}</span></div>`
  }
  
  el.logsContainer.innerHTML = html
  
  // Auto-scroll only if user was already at bottom
  if (isAtBottom) {
    el.logsContainer.scrollTop = el.logsContainer.scrollHeight
  }
}

const METRIC_SIZE_CLASSES = [
  "metric-value--md",
  "metric-value--sm",
  "metric-value--xs",
  "metric-value--xxs"
]

function coerceFiniteNumber(value, fallback = null) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function formatCountFull(value) {
  const n = coerceFiniteNumber(value, null)
  if (n === null) return "—"
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 })
}

/** Compact display for large counters; full value in tooltip. */
function formatCount(value) {
  const n = coerceFiniteNumber(value, null)
  if (n === null) return "—"
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  if (abs >= 1e12) return `${sign}${trimCompact(abs / 1e12)}T`
  if (abs >= 1e9) return `${sign}${trimCompact(abs / 1e9)}B`
  if (abs >= 1e6) return `${sign}${trimCompact(abs / 1e6)}M`
  if (abs >= 1e4) return `${sign}${trimCompact(abs / 1e3)}K`
  return formatCountFull(n)
}

function trimCompact(scaled) {
  const s = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)
  return s.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")
}

function formatMs(value) {
  const ms = coerceFiniteNumber(value, null)
  if (ms === null) return "n/a"
  const abs = Math.abs(ms)
  if (abs >= 60000) return `${trimCompact(abs / 60000)}m`
  if (abs >= 1000) return `${trimCompact(abs / 1000)}s`
  return `${Math.round(ms)} ms`
}

function formatSeconds(value) {
  const seconds = coerceFiniteNumber(value, null)
  if (seconds === null) return "n/a"
  if (seconds >= 3600) return `${trimCompact(seconds / 3600)}h`
  if (seconds >= 60) return `${trimCompact(seconds / 60)}m`
  return `${trimCompact(seconds)}s`
}

function formatBytesShort(bytes) {
  const n = coerceFiniteNumber(bytes, 0)
  const mb = n / (1024 * 1024)
  const abs = Math.abs(mb)
  if (abs >= 1024 * 1024) return `${trimCompact(abs / (1024 * 1024))} TB`
  if (abs >= 1024) return `${trimCompact(abs / 1024)} GB`
  if (abs >= 100) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}

function formatRatioPair(left, right, separator = "/") {
  return `${formatCount(left)}${separator}${formatCount(right)}`
}

function formatRatioPairTitle(left, right, separator = " / ") {
  return `${formatCountFull(left)}${separator}${formatCountFull(right)}`
}

function fitMetricValue(element) {
  if (!element) return
  const len = (element.textContent || "").length
  element.classList.remove(...METRIC_SIZE_CLASSES)
  if (len > 18) element.classList.add("metric-value--xxs")
  else if (len > 14) element.classList.add("metric-value--xs")
  else if (len > 10) element.classList.add("metric-value--sm")
  else if (len > 7) element.classList.add("metric-value--md")
}

function setMetricValue(element, display, options = {}) {
  if (!element) return
  const { title, pulse = false, raw } = options
  const prev = element.textContent
  element.textContent = display
  const fullTitle = title ?? (raw != null ? formatCountFull(raw) : null)
  if (fullTitle && fullTitle !== display && fullTitle !== "—") {
    element.title = fullTitle
  } else {
    element.removeAttribute("title")
  }
  fitMetricValue(element)
  if (pulse && prev !== display) {
    element.classList.add("metric-pulse")
    setTimeout(() => element.classList.remove("metric-pulse"), 200)
  }
}

function setMetricCount(element, value, options = {}) {
  const n = coerceFiniteNumber(value, 0)
  setMetricValue(element, formatCount(n), { ...options, raw: n, pulse: options.pulse !== false })
}

function renderStats(stats) {
  const safeStats = { ...EMPTY_STATS, ...(stats || {}) }
  const hits = safeStats.cacheHits || 0
  const misses = safeStats.cacheMisses || 0
  const fallbacks = safeStats.cacheFallbacks || 0
  const warmups = safeStats.cacheWarmups || 0
  const hitRate =
    Number.isFinite(safeStats.hitRatePercent)
      ? safeStats.hitRatePercent
      : hits + misses > 0
        ? Math.round((hits / (hits + misses)) * 100)
        : 0
  const resolvedLookups = hits + misses + warmups

  setMetricCount(el.statHits, hits)
  setMetricCount(el.statMisses, misses)
  const inCache = Number.isFinite(safeStats.cacheEntries)
    ? safeStats.cacheEntries
    : (safeStats.cachedChunks || safeStats.prefetched || 0)
  setMetricCount(el.statPrefetched, inCache)
  setMetricCount(el.statFailures, safeStats.prefetchFailed)
  setMetricCount(el.statPlaylists, safeStats.playlistsDetected)
  setMetricCount(el.statChunks, safeStats.chunksObserved)
  setMetricCount(el.statLookups, safeStats.cacheLookups || resolvedLookups)
  setMetricCount(el.statWarmups, safeStats.cacheWarmups)

  const buffer = safeStats.bufferHealth || null
  const runwaySec = coerceFiniteNumber(buffer?.runwaySec, null)
  const healthScore = coerceFiniteNumber(buffer?.healthScore, null)
  const tier = buffer?.tier || "unknown"
  setMetricValue(el.statRunway, runwaySec === null ? "n/a" : formatSeconds(runwaySec), {
    title:
      runwaySec === null
        ? undefined
        : `${runwaySec.toFixed(1)}s runway · ${healthScore ?? "n/a"}% health · ${tier}`,
    pulse: false
  })

  const fillBytes = coerceFiniteNumber(safeStats.cacheFillBytes, 0)
  const fillWrites = coerceFiniteNumber(safeStats.cacheFillWrites, 0)
  const totalStoreBytes = coerceFiniteNumber(safeStats.chunkStore?.totalBytesStored, 0)
  const totalStores = coerceFiniteNumber(safeStats.chunkStore?.successfulStores, 0)
  setMetricValue(el.statCacheFilled, formatBytesShort(fillBytes || totalStoreBytes), {
    title: `${formatCountFull(fillWrites || totalStores)} writes · ${formatBytesShort(fillBytes || totalStoreBytes)} stored`,
    pulse: false
  })

  const p95Ms = coerceFiniteNumber(safeStats.requestFirstByteP95Ms, null)
  setMetricValue(el.statTtfb, p95Ms === null ? "n/a" : formatMs(p95Ms), {
    title: p95Ms === null ? undefined : `${formatCountFull(Math.round(p95Ms))} ms`,
    pulse: false
  })

  const stalls = coerceFiniteNumber(safeStats.videoStalls, 0)
  const stallMs = coerceFiniteNumber(safeStats.videoStallMsTotal, 0)
  const stallSec = stallMs / 1000
  const stallDisplay =
    stallSec >= 1000
      ? `${formatCount(stalls)} / ${trimCompact(stallSec / 60)}m`
      : stallSec >= 60
        ? `${formatCount(stalls)} / ${trimCompact(stallSec)}s`
        : `${formatCount(stalls)} / ${stallSec.toFixed(1)}s`
  setMetricValue(el.statStalls, stallDisplay, {
    title: `${formatCountFull(stalls)} stalls · ${formatCountFull(Math.round(stallMs))} ms total`,
    pulse: false
  })
  setMetricCount(el.statEvictSuppressed, safeStats.evictionSuppressedByScrub, {
    title: "Soft evictions deferred while a tab is scrubbing"
  })
  setMetricCount(el.statConsumerSaved, safeStats.consumerProtectedSkips, {
    title: "Chunks skipped during eviction because a player held an in-flight consumer lock"
  })

  el.statHitrate.textContent = `${hitRate}%`
  el.statHitrateBar.style.width = `${hitRate}%`

  if (el.statsScope) {
    const windowLabel = safeStats.activityWindowLabel || "Last 5 min"
    const stored = coerceFiniteNumber(safeStats.chunksStoredInWindow, 0)
    const writes = coerceFiniteNumber(safeStats.cacheFillWrites, 0)
    const filled = coerceFiniteNumber(safeStats.cacheFillBytes, 0)
    const fillLabel =
      writes > 0
        ? `${formatCount(writes)} fills · ${formatBytesShort(filled)}`
        : `${formatCount(stored)} stored`
    el.statsScope.textContent = `${windowLabel} · ${fillLabel} · JIT playback`
    if (stored >= 1e4) el.statsScope.title = `${formatCountFull(stored)} chunks stored`
    else el.statsScope.removeAttribute("title")
  }

  const spec = safeStats.speculative
  if (spec && el.statSpecMode) {
    const mode = (spec.adaptiveMode || "—").slice(0, 12)
    el.statSpecMode.textContent = mode
    el.statSpecMode.title = spec.adaptiveMode && spec.adaptiveMode !== mode ? spec.adaptiveMode : ""

    const hitPct = coerceFiniteNumber(spec.bytesHitRatePercent, null)
    const bytesHit = hitPct === null ? "—" : `${trimCompact(hitPct)}%`
    setMetricValue(el.statSpecHit, bytesHit, {
      title: hitPct === null ? undefined : `${hitPct}% bytes hit rate`,
      pulse: false
    })

    const used = coerceFiniteNumber(spec.used, 0)
    const completed = coerceFiniteNumber(spec.completed, 0)
    setMetricValue(el.statSpecUsed, formatRatioPair(used, completed), {
      title: formatRatioPairTitle(used, completed),
      pulse: false
    })

    const consumed = coerceFiniteNumber(spec.bytesConsumed, 0)
    const downloaded = coerceFiniteNumber(spec.bytesDownloaded, 0)
    setMetricValue(el.statSpecMb, `${formatBytesShort(consumed)} / ${formatBytesShort(downloaded)}`, {
      title: `${formatBytesShort(consumed)} consumed · ${formatBytesShort(downloaded)} downloaded`,
      pulse: false
    })

    setMetricCount(el.statSpecSwitch, spec.qualitySwitchHits || 0)
    el.statSpecMode.classList.remove(
      "speculative-mode--warning",
      "speculative-mode--success",
      "speculative-mode--muted"
    )
    if (spec.adaptiveMode === "minimal") {
      el.statSpecMode.classList.add("speculative-mode--warning")
    } else if (spec.adaptiveMode === "full") {
      el.statSpecMode.classList.add("speculative-mode--success")
    } else {
      el.statSpecMode.classList.add("speculative-mode--muted")
    }
  }
}

function setStatus(text, isError = false) {
  el.globalStatusText.textContent = text
  if (isError) {
    el.globalStatusDot.classList.add("error")
  } else {
    el.globalStatusDot.classList.remove("error")
  }
  // Auto-revert to "Active" after 3 seconds for transient messages
  if (statusTimer) clearTimeout(statusTimer)
  const isStableStatus =
    text === "Active" ||
    text === "Connecting..." ||
    text.startsWith("Active (YouTube")
  if (!isError && !isStableStatus) {
    statusTimer = setTimeout(() => setStatus("Active"), 3000)
  }
}

function currentSettings() {
  return {
    enabled: el.enabled.checked,
    prefetchEnabled: el.prefetchEnabled.checked,
    speculativePrefetchEnabled: el.speculativePrefetchEnabled
      ? el.speculativePrefetchEnabled.checked
      : true,
    serveFromCache: el.serveFromCache.checked,
    prefetchWindow: Math.max(1, Math.min(20, Number(el.prefetchWindow.value) || 6)),
    bfcacheEnforcerEnabled: el.bfcacheEnforcerEnabled.checked,
    documentStreamBoost: el.documentStreamBoost.checked,
    headerEarlyHints: el.headerEarlyHints.checked,
    cpuShieldEnabled: el.cpuShieldEnabled.checked,
    aggressiveScriptDefuserEnabled: el.aggressiveScriptDefuserEnabled.checked
  }
}

function syncAggressiveDefuserAvailability() {
  const cpuOn = el.enabled.checked && el.cpuShieldEnabled.checked
  el.aggressiveScriptDefuserEnabled.disabled = !cpuOn
  if (!cpuOn) {
    el.aggressiveScriptDefuserEnabled.checked = false
  }
}

function syncPerformancePaneAvailability() {
  const on = el.enabled.checked
  if (el.performancePane) {
    el.performancePane.classList.toggle("performance-disabled", !on)
  }
  syncAggressiveDefuserAvailability()
  renderPipelineStatus()
}

function renderPipelineStatus() {
  if (!el.pipelineStatus) return

  if (!el.enabled.checked) {
    el.pipelineStatus.textContent = "Page accelerator paused — enable the extension on Dashboard."
    el.pipelineStatus.classList.remove("active")
    return
  }

  const active = []
  if (el.bfcacheEnforcerEnabled.checked) active.push("BFcache healer")
  if (el.documentStreamBoost.checked) active.push("HTML stream boost")
  if (el.headerEarlyHints.checked) active.push("Header hints")
  if (el.cpuShieldEnabled.checked) {
    active.push(
      el.aggressiveScriptDefuserEnabled.checked
        ? "CPU shield (aggressive)"
        : "CPU shield"
    )
  }

  if (!active.length) {
    el.pipelineStatus.textContent = "All page accelerator pipelines are off."
    el.pipelineStatus.classList.remove("active")
    return
  }

  el.pipelineStatus.textContent = `Active: ${active.join(" · ")}`
  el.pipelineStatus.classList.add("active")
}

// ---------------------------------------------------------------------------
// Data polling
// ---------------------------------------------------------------------------

async function refreshData() {
  try {
    const statsRes = await chrome.runtime.sendMessage({ type: "AegisStream:GetStats" })
    if (statsRes?.ok && statsRes.stats) {
      renderStats(statsRes.stats)
    }
    
    const logsRes = await chrome.runtime.sendMessage({ type: "AegisStream:GetLogs" })
    if (logsRes?.ok && logsRes.logs) {
      renderLogs(logsRes.logs)
    }
  } catch (e) {
    setStatus("Disconnected", true)
  }
}

function startPolling() {
  if (statsPollId) return
  void refreshData()
  statsPollId = setInterval(() => {
    void refreshData()
  }, 1500)
}

function stopPolling() {
  if (!statsPollId) return
  clearInterval(statsPollId)
  statsPollId = null
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function setupTabs() {
  el.tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.target
      
      el.tabBtns.forEach(b => b.classList.remove("active"))
      btn.classList.add("active")
      
      el.tabPanes.forEach(p => p.classList.remove("active"))
      document.getElementById(targetId).classList.add("active")
      
      // Scroll logs to bottom when switching to logs tab
      if (targetId === "logs") {
        requestAnimationFrame(() => {
          el.logsContainer.scrollTop = el.logsContainer.scrollHeight
        })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function bindChangeHandlers() {
  const update = async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "AegisStream:UpdateSettings",
        payload: currentSettings()
      })
      if (!res?.ok) {
        setStatus("Save failed", true)
        return
      }
      setStatus("Settings saved")
    } catch (e) {
      setStatus("Error", true)
    }
  }

  el.enabled.addEventListener("change", () => {
    syncPerformancePaneAvailability()
    void update()
  })
  el.prefetchEnabled.addEventListener("change", () => void update())
  el.serveFromCache.addEventListener("change", () => void update())
  el.prefetchWindow.addEventListener("change", () => void update())

  for (const input of el.performanceControls) {
    input.addEventListener("change", () => {
      if (input === el.cpuShieldEnabled && !el.cpuShieldEnabled.checked) {
        el.aggressiveScriptDefuserEnabled.checked = false
      }
      if (input === el.aggressiveScriptDefuserEnabled && el.aggressiveScriptDefuserEnabled.checked) {
        el.cpuShieldEnabled.checked = true
      }
      syncAggressiveDefuserAvailability()
      renderPipelineStatus()
      void update()
    })
  }

  el.resetStats.addEventListener("click", async () => {
    el.resetStats.disabled = true
    const originalText = el.resetStats.textContent
    el.resetStats.textContent = "..."
    try {
      const res = await chrome.runtime.sendMessage({ type: "AegisStream:ResetStats" })
      if (!res?.ok) throw new Error()
      renderStats(res.stats || EMPTY_STATS)
      setStatus("Stats reset")
    } catch {
      setStatus("Reset failed", true)
    } finally {
      el.resetStats.disabled = false
      el.resetStats.textContent = originalText
    }
  })

  el.clearCache.addEventListener("click", async () => {
    el.clearCache.disabled = true
    const originalText = el.clearCache.textContent
    el.clearCache.textContent = "Clearing..."
    setStatus("Clearing cache...")
    
    try {
      const res = await chrome.runtime.sendMessage({ type: "AegisStream:ClearCache" })
      if (!res?.ok) throw new Error()
      renderStats(res.stats || EMPTY_STATS)
      setStatus("Cache cleared")
    } catch {
      setStatus("Clear failed", true)
    } finally {
      el.clearCache.disabled = false
      el.clearCache.textContent = originalText
    }
  })
  
  el.clearLogs.addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ type: "AegisStream:ClearLogs" })
      void refreshData()
    } catch {
      setStatus("Clear logs failed", true)
    }
  })
  
  el.copyLogs.addEventListener("click", () => {
    if (!latestLogs.length) {
      setStatus("No logs to copy")
      return
    }
    
    const text = latestLogs.map(l => `[${l.timestamp}] [${l.level}] ${l.message}`).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      const btn = el.copyLogs
      const originalText = btn.textContent
      btn.textContent = "Copied!"
      btn.classList.add("copied")
      setTimeout(() => {
        btn.textContent = originalText
        btn.classList.remove("copied")
      }, 2000)
    }).catch(() => {
      setStatus("Copy failed", true)
    })
  })
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  mountThemeMenu(el.themeMenu)
  setupTabs()
  bindChangeHandlers()
  
  try {
    const res = await chrome.runtime.sendMessage({ type: "AegisStream:GetSettings" })
    if (!res?.ok) throw new Error("No response from service worker")

    const { settings, stats } = res
    el.enabled.checked = !!settings.enabled
    el.prefetchEnabled.checked = !!settings.prefetchEnabled
    if (el.speculativePrefetchEnabled) {
      el.speculativePrefetchEnabled.checked = settings.speculativePrefetchEnabled !== false
    }
    el.serveFromCache.checked = !!settings.serveFromCache
    el.prefetchWindow.value = String(settings.prefetchWindow || 6)
    el.bfcacheEnforcerEnabled.checked = settings.bfcacheEnforcerEnabled !== false
    el.documentStreamBoost.checked = settings.documentStreamBoost !== false
    el.headerEarlyHints.checked = settings.headerEarlyHints !== false
    el.cpuShieldEnabled.checked = settings.cpuShieldEnabled !== false
    el.aggressiveScriptDefuserEnabled.checked = settings.aggressiveScriptDefuserEnabled === true
    syncPerformancePaneAvailability()

    renderStats(stats || EMPTY_STATS)
    setStatus("Active")
    
    startPolling()
    window.addEventListener("unload", stopPolling)
  } catch (e) {
    setStatus("Disconnected", true)
  }
}

void init()
