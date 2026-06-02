const el = {
  enabled: document.getElementById("enabled"),
  prefetchEnabled: document.getElementById("prefetchEnabled"),
  serveFromCache: document.getElementById("serveFromCache"),
  prefetchWindow: document.getElementById("prefetchWindow"),
  
  statHits: document.getElementById("stat-hits"),
  statMisses: document.getElementById("stat-misses"),
  statPrefetched: document.getElementById("stat-prefetched"),
  statFailures: document.getElementById("stat-failures"),
  statPlaylists: document.getElementById("stat-playlists"),
  statChunks: document.getElementById("stat-chunks"),
  statLookups: document.getElementById("stat-lookups"),
  statWarmups: document.getElementById("stat-warmups"),
  statTtfb: document.getElementById("stat-ttfb"),
  statStalls: document.getElementById("stat-stalls"),
  statHitrate: document.getElementById("stat-hitrate"),
  statHitrateBar: document.getElementById("stat-hitrate-bar"),
  
  clearCache: document.getElementById("clearCache"),
  
  globalStatusDot: document.getElementById("global-status-dot"),
  globalStatusText: document.getElementById("global-status-text"),
  
  tabBtns: document.querySelectorAll(".tab-btn"),
  tabPanes: document.querySelectorAll(".tab-pane"),
  
  logsContainer: document.getElementById("logsContainer"),
  clearLogs: document.getElementById("clearLogs"),
  copyLogs: document.getElementById("copyLogs"),
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
  youtubeUmpChunks: 0,
  youtubeUmpRequests: 0,
  youtubeUmpLookups: 0,
  youtubeUmpLookupHits: 0,
  youtubeUmpLookupMisses: 0,
  youtubeUmpWarmups: 0,
  youtubeUmpUniqueKeys: 0,
  youtubeUmpStreamsCompleted: 0,
  youtubeUmpStreamsAborted: 0,
  youtubeUmpStreamsErrored: 0,
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
  videoStallLongestMs: 0
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

function animateValue(element, newValue) {
  const current = parseInt(element.textContent, 10) || 0
  if (current !== newValue) {
    element.textContent = newValue
    element.style.transition = "transform 0.2s ease"
    element.style.transform = "scale(1.15)"
    setTimeout(() => { element.style.transform = "scale(1)" }, 200)
  }
}

function renderStats(stats) {
  const safeStats = { ...EMPTY_STATS, ...(stats || {}) }
  const effectiveMisses = (safeStats.cacheMisses || 0) + (safeStats.cacheWarmups || 0)
  const totalLookups = safeStats.cacheHits + effectiveMisses
  const hitRateRaw = totalLookups > 0 ? (safeStats.cacheHits / totalLookups) * 100 : 0
  const hitRate = Math.round(hitRateRaw)
  
  animateValue(el.statHits, safeStats.cacheHits)
  animateValue(el.statMisses, effectiveMisses)
  animateValue(el.statPrefetched, safeStats.cachedChunks || safeStats.prefetched || 0)
  animateValue(el.statFailures, safeStats.prefetchFailed)
  animateValue(el.statPlaylists, safeStats.playlistsDetected)
  animateValue(el.statChunks, safeStats.chunksObserved)
  animateValue(el.statLookups, safeStats.cacheLookups || totalLookups)
  animateValue(el.statWarmups, safeStats.cacheWarmups)

  const p95 = Number.isFinite(safeStats.requestFirstByteP95Ms)
    ? `${safeStats.requestFirstByteP95Ms} ms`
    : "n/a"
  el.statTtfb.textContent = p95

  const stallSeconds = ((safeStats.videoStallMsTotal || 0) / 1000).toFixed(1)
  el.statStalls.textContent = `${safeStats.videoStalls || 0} / ${stallSeconds}s`
  
  el.statHitrate.textContent = `${hitRate}%`
  el.statHitrateBar.style.width = `${hitRate}%`

  // Make operating mode explicit so UMP behavior is not misread as "broken cache".
  if ((safeStats.youtubeUmpRequests || 0) > 0 && (safeStats.playlistsDetected || 0) === 0) {
    setStatus("Active (YouTube realtime mode)")
  } else if (el.globalStatusText.textContent.startsWith("Active (YouTube")) {
    setStatus("Active")
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
    serveFromCache: el.serveFromCache.checked,
    prefetchWindow: Math.max(1, Math.min(20, Number(el.prefetchWindow.value) || 6))
  }
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

  el.enabled.addEventListener("change", () => void update())
  el.prefetchEnabled.addEventListener("change", () => void update())
  el.serveFromCache.addEventListener("change", () => void update())
  el.prefetchWindow.addEventListener("change", () => void update())

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
  setupTabs()
  bindChangeHandlers()
  
  try {
    const res = await chrome.runtime.sendMessage({ type: "AegisStream:GetSettings" })
    if (!res?.ok) throw new Error("No response from service worker")

    const { settings, stats } = res
    el.enabled.checked = !!settings.enabled
    el.prefetchEnabled.checked = !!settings.prefetchEnabled
    el.serveFromCache.checked = !!settings.serveFromCache
    el.prefetchWindow.value = String(settings.prefetchWindow || 6)
    
    renderStats(stats || EMPTY_STATS)
    setStatus("Active")
    
    startPolling()
    window.addEventListener("unload", stopPolling)
  } catch (e) {
    setStatus("Disconnected", true)
  }
}

void init()
