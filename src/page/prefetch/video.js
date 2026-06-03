(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("prefetch-video")) return
const {
  originalFetch,
  stripHash,
  notifyRuntime,
  requestRuntime,
  requestExtensionFetchBuffered,
  monotonicNow,
  reportRuntimeMetric
} = ns

const PREFETCH_CONCURRENCY = 3
const MAX_PREFETCH_QUEUE_SIZE = 240
const PREFETCH_QUEUE_MAX_AGE_MS = 15_000
const activePrefetches = new Set()
const queuedPrefetches = new Set()
const prefetchQueuedAt = new Map()
const prefetchQueue = []
const prefetchQueueWaiters = []
const prefetchAbortControllers = new Map()
let prefetchWorkersStarted = false
const observedChunkAt = new Map()
const knownUmpCacheKeys = new Set()
const MAX_UMP_CAPTURE_BYTES = 20 * 1024 * 1024
const MAX_ACTIVE_UMP_CAPTURES = 2
ns.activeUmpCaptureCount = 0
ns.lastUmpCaptureBackpressureLogAt = 0
const CHUNK_OBSERVED_DEBOUNCE_MS = 2000
const STORE_RETRY_ATTEMPTS = 2
const STORE_RETRY_DELAY_MS = 60

function isPagePrefetchAllowed() {
  return typeof document === "undefined" || document.visibilityState === "visible"
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getBufferTier() {
  return typeof ns.bufferTier === "string" ? ns.bufferTier : null
}

function isMaintenancePrefetchMode() {
  const tier = getBufferTier()
  return tier === ns.TIER_MAINTENANCE || tier === ns.TIER_IDLE
}

function getBufferAdjustedConcurrency() {
  const tier = getBufferTier()
  const healthScore = Number(ns.bufferHealthScore)
  if (!tier) return PREFETCH_CONCURRENCY

  switch (tier) {
    case ns.TIER_EMERGENCY:
      return Math.min(5, PREFETCH_CONCURRENCY + 2)
    case ns.TIER_AGGRESSIVE:
      return Math.min(4, PREFETCH_CONCURRENCY + 1)
    case ns.TIER_NORMAL:
      return PREFETCH_CONCURRENCY
    case ns.TIER_MAINTENANCE:
    case ns.TIER_IDLE:
      return 1
    default:
      if (Number.isFinite(healthScore) && healthScore < 40) {
        return PREFETCH_CONCURRENCY
      }
      return 1
  }
}

let activePrefetchWorkerCount = 0

function isTransientStoreFailure(storeRes) {
  if (!storeRes || storeRes.ok) return false
  const error = String(storeRes.error || "").toLowerCase()
  if (!error) return true
  return /runtime|timeout|serialize|message port|context invalidated|unknown/i.test(error)
}

async function storeChunkForPrefetch(payload) {
  let lastRes = { ok: false, error: "store failed" }
  for (let attempt = 0; attempt < STORE_RETRY_ATTEMPTS; attempt += 1) {
    lastRes = await requestRuntime("STORE_CHUNK_REQUEST", payload)
    if (lastRes?.ok) return lastRes
    if (!isTransientStoreFailure(lastRes) || attempt >= STORE_RETRY_ATTEMPTS - 1) {
      return lastRes
    }
    await sleep(STORE_RETRY_DELAY_MS * (attempt + 1))
  }
  return lastRes
}

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

function cancelPrefetchRunway(keepUrls = []) {
  const keep = new Set(keepUrls.filter(Boolean))
  for (const [url, controller] of prefetchAbortControllers.entries()) {
    if (!keep.has(url)) {
      controller.abort()
      prefetchAbortControllers.delete(url)
    }
  }
  prefetchQueue.length = 0
  for (const url of Array.from(queuedPrefetches)) {
    if (keep.has(url)) continue
    queuedPrefetches.delete(url)
    prefetchQueuedAt.delete(url)
    notifyRuntime("PREFETCH_RESULT", {
      url,
      success: false,
      skipped: "stale-queue",
      transient: true
    })
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

async function fetchPrefetchBytesWithExtension(url) {
  const extensionRes = await requestExtensionFetchBuffered({
    url,
    method: "GET",
    headers: {}
  })
  if (!extensionRes?.ok) {
    return {
      ok: false,
      error: extensionRes?.error
        ? `extension fetch failed: ${extensionRes.error}`
        : "extension fetch failed",
      transient: true
    }
  }

  const statusCode = Number(extensionRes.statusCode || 0)
  if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
    return {
      ok: false,
      error: `extension HTTP ${statusCode || "unknown"}`,
      transient: statusCode >= 500 || statusCode === 0
    }
  }

  const bytes = extensionRes.bytes
  if (!bytes || typeof bytes.byteLength !== "number" || bytes.byteLength === 0) {
    return {
      ok: false,
      error: "extension empty response",
      transient: true
    }
  }

  return {
    ok: true,
    bytes,
    contentType:
      getHeaderValue(extensionRes.headers, "content-type") || "application/octet-stream",
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
    if (typeof ns.recordBufferStall === "function") {
      ns.recordBufferStall(durationMs)
    }
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

function isPrefetchUrlStale(url) {
  const queuedAt = prefetchQueuedAt.get(url)
  if (!queuedAt) return false
  return Date.now() - queuedAt > PREFETCH_QUEUE_MAX_AGE_MS
}

function dropStalePrefetchUrl(url) {
  prefetchQueuedAt.delete(url)
  queuedPrefetches.delete(url)
  notifyRuntime("PREFETCH_RESULT", {
    url,
    success: false,
    skipped: "stale-queue",
    transient: true
  })
}

function purgeStaleQueuedPrefetches() {
  if (prefetchQueue.length === 0) return
  const now = Date.now()
  let write = 0
  for (let read = 0; read < prefetchQueue.length; read += 1) {
    const url = prefetchQueue[read]
    const queuedAt = prefetchQueuedAt.get(url) || 0
    if (queuedAt > 0 && now - queuedAt > PREFETCH_QUEUE_MAX_AGE_MS) {
      dropStalePrefetchUrl(url)
      continue
    }
    prefetchQueue[write] = url
    write += 1
  }
  prefetchQueue.length = write
}

function trimPrefetchQueue() {
  while (prefetchQueue.length > MAX_PREFETCH_QUEUE_SIZE) {
    const dropped = prefetchQueue.pop()
    if (!dropped) continue
    queuedPrefetches.delete(dropped)
    prefetchQueuedAt.delete(dropped)
  }
}

function dequeuePrefetchUrl() {
  purgeStaleQueuedPrefetches()
  while (prefetchQueue.length > 0) {
    const url = prefetchQueue.shift()
    if (!url) continue
    if (!queuedPrefetches.has(url)) {
      prefetchQueuedAt.delete(url)
      continue
    }
    if (isPrefetchUrlStale(url)) {
      dropStalePrefetchUrl(url)
      continue
    }
    queuedPrefetches.delete(url)
    prefetchQueuedAt.delete(url)
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
  if (!isPagePrefetchAllowed()) {
    notifyRuntime("PREFETCH_RESULT", {
      url,
      success: false,
      skipped: "tab-hidden",
      transient: true
    })
    return
  }

  const controller = new AbortController()
  prefetchAbortControllers.set(url, controller)

  let bytes = null
  let contentType = "application/octet-stream"
  let requestStatus = 0

  try {
  // Fetch without credentials first (most CDNs use wildcard CORS which breaks with credentials)
  // The browser will use the cache/cookies appropriate for the origin automatically
  let res = await originalFetch(url, { cache: "no-store", signal: controller.signal })
  
  // If 403, fallback to include credentials just in case it's same-origin and requires them
  if (res.status === 403 || res.status === 401) {
     res = await originalFetch(url, {
       credentials: "include",
       cache: "no-store",
       signal: controller.signal
     })
  }
  requestStatus = Number(res.status || 0)
  if (res.ok && res.status !== 206) {
    contentType = res.headers.get("content-type") || "application/octet-stream"
    bytes = await res.arrayBuffer()
  } else {
    if (controller.signal.aborted) return
    const extensionFallback = await fetchPrefetchBytesWithExtension(url)
    if (!extensionFallback.ok) {
      const transient =
        extensionFallback.transient === true ||
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
            ? `HTTP ${requestStatus}; ${extensionFallback.error}`
            : extensionFallback.error,
        transient
      })
      return
    }
    bytes = extensionFallback.bytes
    contentType = extensionFallback.contentType
    requestStatus = extensionFallback.statusCode
  }

  if (!bytes || bytes.byteLength === 0) {
    notifyRuntime("PREFETCH_RESULT", { url, success: false, error: "empty response" })
    return
  }

  // Send bytes to background for caching
  const storeRes = await storeChunkForPrefetch({
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
      error: storeRes?.error ? `store failed: ${storeRes.error}` : "store failed",
      transient: isTransientStoreFailure(storeRes)
    })
    return
  }

  notifyRuntime("PREFETCH_RESULT", { url, success: true, size: bytes.byteLength })
  } catch (e) {
    if (e?.name === "AbortError") {
      notifyRuntime("PREFETCH_RESULT", {
        url,
        success: false,
        skipped: "stale-queue",
        transient: true
      })
      return
    }
    throw e
  } finally {
    prefetchAbortControllers.delete(url)
  }
}

async function runPrefetchWorker() {
  while (true) {
    const maxConcurrent = getBufferAdjustedConcurrency()
    const maintenance = isMaintenancePrefetchMode()
    if (maintenance && activePrefetchWorkerCount >= 1) {
      await sleep(1200)
      continue
    }
    if (activePrefetchWorkerCount >= maxConcurrent) {
      await sleep(120)
      continue
    }

    purgeStaleQueuedPrefetches()
    const url = dequeuePrefetchUrl()
    if (!url) {
      await waitForPrefetchWork()
      continue
    }
    activePrefetchWorkerCount += 1
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
      activePrefetchWorkerCount = Math.max(0, activePrefetchWorkerCount - 1)
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
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) {
    return
  }
  const unique = []
  const seen = new Set()
  for (const url of urls) {
    if (!url || seen.has(url)) continue
    seen.add(url)
    unique.push(url)
  }

  if (!isPagePrefetchAllowed()) {
    for (const url of unique) {
      notifyRuntime("PREFETCH_RESULT", {
        url,
        success: false,
        skipped: "tab-hidden",
        transient: true
      })
    }
    return
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

  cancelPrefetchRunway(unique)

  const now = Date.now()
  for (const url of toQueue) {
    queuedPrefetches.add(url)
    prefetchQueuedAt.set(url, now)
    prefetchQueue.push(url)
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
