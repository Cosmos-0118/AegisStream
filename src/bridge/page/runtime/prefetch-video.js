(() => {
var ns = (self.AegisPageBridge ||= {})
if (ns.__prefetchVideoInstalled === true) return
ns.__prefetchVideoInstalled = true
const {
  originalFetch,
  stripHash,
  notifyRuntime,
  requestRuntime,
  monotonicNow,
  reportRuntimeMetric
} = ns

const PREFETCH_CONCURRENCY = 3
const MAX_PREFETCH_QUEUE_SIZE = 240
const activePrefetches = new Set()
const queuedPrefetches = new Set()
const prefetchQueue = []
const prefetchQueueWaiters = []
let prefetchWorkersStarted = false
const observedChunkAt = new Map()
const knownUmpCacheKeys = new Set()
const MAX_UMP_CAPTURE_BYTES = 20 * 1024 * 1024
const MAX_ACTIVE_UMP_CAPTURES = 2
ns.activeUmpCaptureCount = 0
ns.lastUmpCaptureBackpressureLogAt = 0
const CHUNK_OBSERVED_DEBOUNCE_MS = 2000

function rememberKnownUmpKey(cacheKey) {
  if (!cacheKey || typeof cacheKey !== "string") return
  knownUmpCacheKeys.add(cacheKey)
  if (knownUmpCacheKeys.size > 5000) {
    const toDelete = Array.from(knownUmpCacheKeys).slice(0, 1000)
    for (const key of toDelete) {
      knownUmpCacheKeys.delete(key)
    }
  }
}

function notifyChunkObserved(url) {
  const normalized = stripHash(url)
  if (!normalized) return

  const now = Date.now()
  const last = observedChunkAt.get(normalized) || 0
  if (now - last < CHUNK_OBSERVED_DEBOUNCE_MS) return
  observedChunkAt.set(normalized, now)

  if (observedChunkAt.size > 3000) {
    const cutoff = now - CHUNK_OBSERVED_DEBOUNCE_MS * 2
    for (const [key, ts] of observedChunkAt.entries()) {
      if (ts < cutoff) observedChunkAt.delete(key)
    }
  }

  notifyRuntime("CHUNK_OBSERVED", { url: normalized })
}

function getHeaderValue(headers, targetName) {
  if (!headers || typeof headers !== "object") return null
  const normalizedTarget = String(targetName || "").toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === normalizedTarget) {
      return typeof value === "string" ? value : null
    }
  }
  return null
}

async function fetchPrefetchBytesWithDaemon(url) {
  const daemonRes = await requestRuntime("DAEMON_FETCH_REQUEST", {
    url,
    method: "GET",
    headers: {}
  })
  if (!daemonRes?.ok) {
    return {
      ok: false,
      error: daemonRes?.error ? `daemon failed: ${daemonRes.error}` : "daemon failed",
      transient: true
    }
  }

  const statusCode = Number(daemonRes.statusCode || 0)
  if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
    return {
      ok: false,
      error: `daemon HTTP ${statusCode || "unknown"}`,
      transient: statusCode >= 500 || statusCode === 0
    }
  }

  const bytesArray = Array.isArray(daemonRes.bytes) ? daemonRes.bytes : null
  if (!bytesArray || bytesArray.length === 0) {
    return {
      ok: false,
      error: "daemon empty response",
      transient: true
    }
  }

  const uint8 = Uint8Array.from(bytesArray)
  return {
    ok: true,
    bytes: uint8.buffer,
    contentType: getHeaderValue(daemonRes.headers, "content-type") || "application/octet-stream",
    statusCode
  }
}

const monitoredVideos = new WeakSet()
const activeVideoStalls = new WeakMap()

function attachVideoHealthListeners(video) {
  if (!(video instanceof HTMLMediaElement) || monitoredVideos.has(video)) return
  monitoredVideos.add(video)

  const beginStall = (reason) => {
    if (video.paused || video.ended) return
    if (video.readyState >= 3) return
    if (activeVideoStalls.has(video)) return
    activeVideoStalls.set(video, {
      startedAt: monotonicNow(),
      reason
    })
  }

  const endStall = (reason) => {
    const stall = activeVideoStalls.get(video)
    if (!stall) return
    activeVideoStalls.delete(video)

    if (reason === "pause" || reason === "ended") return

    const durationMs = Math.round(monotonicNow() - stall.startedAt)
    if (!Number.isFinite(durationMs) || durationMs < 120) return

    reportRuntimeMetric("video_stall", {
      durationMs,
      reason: `${stall.reason}->${reason}`,
      atSeconds: Number.isFinite(video.currentTime) ? Number(video.currentTime.toFixed(2)) : null
    })
  }

  video.addEventListener("waiting", () => beginStall("waiting"))
  video.addEventListener("stalled", () => beginStall("stalled"))
  video.addEventListener("playing", () => endStall("playing"))
  video.addEventListener("canplay", () => endStall("canplay"))
  video.addEventListener("seeked", () => endStall("seeked"))
  video.addEventListener("pause", () => endStall("pause"))
  video.addEventListener("ended", () => endStall("ended"))
}

function installVideoHealthMonitor() {
  const attachExisting = () => {
    document.querySelectorAll("video").forEach((video) => {
      attachVideoHealthListeners(video)
    })
  }

  attachExisting()

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue
        if (node.tagName === "VIDEO") {
          attachVideoHealthListeners(node)
        }
        node.querySelectorAll?.("video").forEach((video) => {
          attachVideoHealthListeners(video)
        })
      }
    }
  })

  const root = document.documentElement || document.body
  if (!root) {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        installVideoHealthMonitor()
      },
      { once: true }
    )
    return
  }

  observer.observe(root, { childList: true, subtree: true })
}

installVideoHealthMonitor()

function trimPrefetchQueue() {
  while (prefetchQueue.length > MAX_PREFETCH_QUEUE_SIZE) {
    const dropped = prefetchQueue.pop()
    if (!dropped) continue
    queuedPrefetches.delete(dropped)
  }
}

function dequeuePrefetchUrl() {
  while (prefetchQueue.length > 0) {
    const url = prefetchQueue.shift()
    if (!url) continue
    if (!queuedPrefetches.has(url)) continue
    queuedPrefetches.delete(url)
    if (activePrefetches.has(url)) continue
    return url
  }
  return null
}

function waitForPrefetchWork() {
  if (prefetchQueue.length > 0) return Promise.resolve()
  return new Promise((resolve) => {
    prefetchQueueWaiters.push(resolve)
  })
}

function notifyPrefetchWorkers() {
  if (!prefetchQueueWaiters.length) return
  const waiters = prefetchQueueWaiters.splice(0, prefetchQueueWaiters.length)
  for (const resolve of waiters) {
    resolve()
  }
}

async function processPrefetchUrl(url) {
  let bytes = null
  let contentType = "application/octet-stream"
  let requestStatus = 0

  // Fetch without credentials first (most CDNs use wildcard CORS which breaks with credentials)
  // The browser will use the cache/cookies appropriate for the origin automatically
  let res = await originalFetch(url, { cache: "no-store" })
  
  // If 403, fallback to include credentials just in case it's same-origin and requires them
  if (res.status === 403 || res.status === 401) {
     res = await originalFetch(url, { credentials: "include", cache: "no-store" })
  }
  requestStatus = Number(res.status || 0)
  if (res.ok && res.status !== 206) {
    contentType = res.headers.get("content-type") || "application/octet-stream"
    bytes = await res.arrayBuffer()
  } else {
    const daemonFallback = await fetchPrefetchBytesWithDaemon(url)
    if (!daemonFallback.ok) {
      const transient =
        daemonFallback.transient === true ||
        requestStatus === 0 ||
        requestStatus === 408 ||
        requestStatus === 425 ||
        requestStatus === 429 ||
        requestStatus >= 500
      notifyRuntime("PREFETCH_RESULT", {
        url,
        success: false,
        error:
          requestStatus > 0
            ? `HTTP ${requestStatus}; ${daemonFallback.error}`
            : daemonFallback.error,
        transient
      })
      return
    }
    bytes = daemonFallback.bytes
    contentType = daemonFallback.contentType
    requestStatus = daemonFallback.statusCode
  }

  if (!bytes || bytes.byteLength === 0) {
    notifyRuntime("PREFETCH_RESULT", { url, success: false, error: "empty response" })
    return
  }

  // Send bytes to background for caching
  const storeRes = await requestRuntime("STORE_CHUNK_REQUEST", {
    url,
    contentType,
    bytes,
    // Treat prefetch payload as full representation for this exact key.
    status: 200,
    method: "GET",
    hasRange: false
  })

  if (!storeRes?.ok) {
    notifyRuntime("PREFETCH_RESULT", {
      url,
      success: false,
      error: storeRes?.error ? `store failed: ${storeRes.error}` : "store failed"
    })
    return
  }

  notifyRuntime("PREFETCH_RESULT", { url, success: true, size: bytes.byteLength })
}

async function runPrefetchWorker() {
  while (true) {
    const url = dequeuePrefetchUrl()
    if (!url) {
      await waitForPrefetchWork()
      continue
    }
    activePrefetches.add(url)
    try {
      await processPrefetchUrl(url)
    } catch (e) {
      const message = e?.message || "unknown"
      const transient = /failed to fetch|aborted|aborterror|networkerror|load failed/i.test(
        String(message).toLowerCase()
      )
      notifyRuntime("PREFETCH_RESULT", {
        url,
        success: false,
        error: message,
        transient
      })
    } finally {
      activePrefetches.delete(url)
    }
  }
}

function ensurePrefetchWorkers() {
  if (prefetchWorkersStarted) return
  prefetchWorkersStarted = true
  for (let i = 0; i < PREFETCH_CONCURRENCY; i += 1) {
    void runPrefetchWorker()
  }
}

async function prefetchSegmentsFromPage(urls) {
  const unique = []
  const seen = new Set()
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    unique.push(url)
  }

  const skippedInflight = []
  const toQueue = []
  for (const url of unique) {
    if (activePrefetches.has(url)) {
      skippedInflight.push(url)
      continue
    }
    if (queuedPrefetches.has(url)) continue
    toQueue.push(url)
  }

  if (skippedInflight.length) {
    // Important: background marks delegated URLs as inflight. If we drop an
    // already-active URL silently, it can stay inflight and block scheduling.
    for (const url of skippedInflight) {
      notifyRuntime("PREFETCH_RESULT", {
        url,
        success: true,
        skipped: "already-inflight"
      })
    }
  }

  if (!toQueue.length) return

  // Newest anchor updates are typically the most relevant under rapid seeks.
  for (let i = toQueue.length - 1; i >= 0; i -= 1) {
    const url = toQueue[i]
    queuedPrefetches.add(url)
    prefetchQueue.unshift(url)
  }
  trimPrefetchQueue()
  notifyPrefetchWorkers()
  ensurePrefetchWorkers()
}

ns.PREFETCH_CONCURRENCY = PREFETCH_CONCURRENCY
ns.activePrefetches = activePrefetches
ns.observedChunkAt = observedChunkAt
ns.knownUmpCacheKeys = knownUmpCacheKeys
ns.MAX_UMP_CAPTURE_BYTES = MAX_UMP_CAPTURE_BYTES
ns.MAX_ACTIVE_UMP_CAPTURES = MAX_ACTIVE_UMP_CAPTURES
ns.CHUNK_OBSERVED_DEBOUNCE_MS = CHUNK_OBSERVED_DEBOUNCE_MS
ns.rememberKnownUmpKey = rememberKnownUmpKey
ns.notifyChunkObserved = notifyChunkObserved
ns.prefetchSegmentsFromPage = prefetchSegmentsFromPage

})()
