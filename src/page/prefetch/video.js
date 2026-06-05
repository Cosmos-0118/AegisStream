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

function emitPrefetchFailure(url, details) {
  const payload =
    typeof ns.buildPrefetchFailureResult === "function"
      ? ns.buildPrefetchFailureResult(url, {
          ...details,
          networkGeneration: pageNetworkGeneration
        })
      : {
          url,
          success: false,
          error: details.errorMessage || details.error || "unknown",
          networkGeneration: pageNetworkGeneration,
          transient: details.transient === true,
          authFailure: details.authFailure === true,
          rateLimit: details.rateLimit === true
        }
  notifyRuntime("PREFETCH_RESULT", payload)
}

function emitPrefetchSkipped(url, skipped, extra = {}) {
  notifyRuntime("PREFETCH_RESULT", {
    url,
    success: false,
    skipped,
    networkGeneration: pageNetworkGeneration,
    transient: extra.transient === true
  })
}

function isUrlGenerationCurrent(url) {
  const queuedGen = urlQueuedGeneration.get(url)
  return queuedGen === pageNetworkGeneration
}

const PREFETCH_CONCURRENCY = 3
const MAX_PREFETCH_QUEUE_SIZE = 240
const PREFETCH_QUEUE_MAX_AGE_MS = 15_000
const activePrefetches = new Set()
const queuedPrefetches = new Set()
const prefetchQueuedAt = new Map()
const prefetchQueue = []
const prefetchQueueWaiters = []
const prefetchAbortControllers = new Map()
const urlQueuedGeneration = new Map()
let pageNetworkGeneration = 0
let pagePrefetchPriority = "low"
let prefetchWorkersStarted = false
const observedChunkAt = new Map()
const knownUmpCacheKeys = new Set()
const MAX_UMP_CAPTURE_BYTES = 20 * 1024 * 1024
const MAX_ACTIVE_UMP_CAPTURES = 2
ns.activeUmpCaptureCount = 0
ns.lastUmpCaptureBackpressureLogAt = 0
const CHUNK_OBSERVED_DEBOUNCE_MS = 2000

function isPagePrefetchAllowed() {
  if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return false
  if (ns.pageVisibilitySleep === true) return false
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

function getRequiredConcurrency(healthScore) {
  const score = Number(healthScore)
  if (!Number.isFinite(score)) return PREFETCH_CONCURRENCY
  if (score > 80) return 1
  if (score > 40) return 2
  return 4
}

function getBufferAdjustedConcurrency() {
  const healthScore = Number(ns.bufferHealthScore)
  if (Number.isFinite(healthScore)) {
    const required = getRequiredConcurrency(healthScore)
    if (ns.networkPanicActive === true) {
      return Math.max(required, 4)
    }
    return required
  }
  const tier = getBufferTier()
  if (!tier) {
    return ns.networkPanicActive === true ? 4 : PREFETCH_CONCURRENCY
  }
  if (tier === ns.TIER_EMERGENCY || tier === ns.TIER_AGGRESSIVE) return 4
  if (tier === ns.TIER_MAINTENANCE || tier === ns.TIER_IDLE) return 1
  return PREFETCH_CONCURRENCY
}

let activePrefetchWorkerCount = 0

async function storeChunkForPrefetch(payload) {
  if (typeof ns.storeChunkFromPage === "function") {
    return ns.storeChunkFromPage(payload)
  }
  return requestRuntime("STORE_CHUNK_REQUEST", payload)
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

function clearPrefetchIntentForUrl(url) {
  if (typeof ns.clearPrefetchIntent === "function") {
    ns.clearPrefetchIntent(url)
  }
}

function notePrefetchIntentForUrl(url) {
  if (typeof ns.notePrefetchIntent === "function") {
    ns.notePrefetchIntent(url)
  }
}

function cancelPrefetchRunway(keepUrls = [], options = {}) {
  if (Number.isFinite(Number(options.networkGeneration))) {
    pageNetworkGeneration = Number(options.networkGeneration)
  }
  const keep = new Set(keepUrls.filter(Boolean))
  if (typeof ns.collectCoalesceProtectedUrls === "function") {
    for (const url of ns.collectCoalesceProtectedUrls()) {
      keep.add(url)
    }
  }
  const aborted = prefetchAbortControllers.size + prefetchQueue.length
  for (const [url, controller] of prefetchAbortControllers.entries()) {
    if (
      !keep.has(url) &&
      typeof ns.isCoalesceAbortLocked === "function" &&
      ns.isCoalesceAbortLocked(url, url)
    ) {
      keep.add(url)
    }
    if (!keep.has(url)) {
      controller.abort()
      prefetchAbortControllers.delete(url)
      urlQueuedGeneration.delete(url)
      clearPrefetchIntentForUrl(url)
    }
  }
  const queueSnapshot = prefetchQueue.splice(0, prefetchQueue.length)
  for (const url of queueSnapshot) {
    if (keep.has(url)) {
      prefetchQueue.push(url)
      continue
    }
    queuedPrefetches.delete(url)
    prefetchQueuedAt.delete(url)
    urlQueuedGeneration.delete(url)
    clearPrefetchIntentForUrl(url)
    emitPrefetchSkipped(url, "aborted")
  }
  for (const url of Array.from(queuedPrefetches)) {
    if (keep.has(url)) continue
    queuedPrefetches.delete(url)
    prefetchQueuedAt.delete(url)
    urlQueuedGeneration.delete(url)
    clearPrefetchIntentForUrl(url)
    emitPrefetchSkipped(url, "aborted")
  }
  if (typeof ns.cancelInflightChunkStores === "function") {
    ns.cancelInflightChunkStores(options.reason || "cancel-prefetch")
  }
  if (aborted > 0 && typeof ns.logBridge === "function") {
    ns.logBridge(
      `Delegated prefetch abort: stopped ${aborted} queued/in-flight segment fetch(es)${options.reason ? ` (${options.reason})` : ""}`,
      "DEBUG"
    )
  }
}

function notifyChunkObserved(url) {
  if (ns.extensionEnabled === false) return
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
    headers: {},
    source: "prefetch-video"
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

if (!globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) {
  installVideoHealthMonitor()
}

function isPrefetchUrlStale(url) {
  const queuedAt = prefetchQueuedAt.get(url)
  if (!queuedAt) return false
  return Date.now() - queuedAt > PREFETCH_QUEUE_MAX_AGE_MS
}

function dropStalePrefetchUrl(url) {
  prefetchQueuedAt.delete(url)
  queuedPrefetches.delete(url)
  urlQueuedGeneration.delete(url)
  clearPrefetchIntentForUrl(url)
  emitPrefetchSkipped(url, "stale-queue", { transient: true })
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
    if (!isUrlGenerationCurrent(url)) {
      queuedPrefetches.delete(url)
      prefetchQueuedAt.delete(url)
      urlQueuedGeneration.delete(url)
      emitPrefetchSkipped(url, "generation-stale")
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
  const key =
    typeof ns.resolvePrefetchCoalesceKey === "function"
      ? ns.resolvePrefetchCoalesceKey(url)
      : stripHash(url)
  const runWork = () => processPrefetchUrlWork(url)
  if (typeof ns.beginCoalescedNetworkFetch === "function" && key) {
    return ns.beginCoalescedNetworkFetch(key, runWork, url)
  }
  return runWork()
}

async function processPrefetchUrlWork(url) {
  if (!isPagePrefetchAllowed()) {
    clearPrefetchIntentForUrl(url)
    emitPrefetchSkipped(url, "tab-hidden", { transient: true })
    return { ok: false, skipped: "tab-hidden" }
  }
  if (!isUrlGenerationCurrent(url)) {
    clearPrefetchIntentForUrl(url)
    emitPrefetchSkipped(url, "generation-stale")
    return { ok: false, skipped: "generation-stale" }
  }

  const controller = new AbortController()
  prefetchAbortControllers.set(url, controller)

  let bytes = null
  let contentType = "application/octet-stream"
  let requestStatus = 0

  try {
  // Fetch without credentials first (most CDNs use wildcard CORS which breaks with credentials)
  // The browser will use the cache/cookies appropriate for the origin automatically
  const fetchPriority = pagePrefetchPriority === "high" ? "high" : "low"
  let res = await originalFetch(url, {
    cache: "no-store",
    signal: controller.signal,
    priority: fetchPriority
  })
  
  // If 403, fallback to include credentials just in case it's same-origin and requires them
  if (res.status === 403 || res.status === 401) {
     res = await originalFetch(url, {
       credentials: "include",
       cache: "no-store",
       signal: controller.signal,
       priority: fetchPriority
     })
  }
  requestStatus = Number(res.status || 0)
  if (res.ok && res.status !== 206) {
    contentType = res.headers.get("content-type") || "application/octet-stream"
    bytes = await res.arrayBuffer()
  } else {
    if (controller.signal.aborted) return { ok: false, aborted: true }
    const extensionFallback = await fetchPrefetchBytesWithExtension(url)
    if (!extensionFallback.ok) {
      const authFailure = requestStatus === 403 || requestStatus === 401
      const rateLimit = requestStatus === 429
      const transient =
        !authFailure &&
        !rateLimit &&
        (extensionFallback.transient === true ||
          requestStatus === 0 ||
          requestStatus === 408 ||
          requestStatus === 425 ||
          requestStatus >= 500)
      clearPrefetchIntentForUrl(url)
      emitPrefetchFailure(url, {
          fetchMode: "page",
          fetchPath:
            extensionFallback.ok === false && requestStatus > 0
              ? "originalFetch+extension"
              : requestStatus > 0
                ? "originalFetch"
                : "extension",
          status:
            requestStatus > 0
              ? requestStatus
              : Number(extensionFallback.statusCode) || 0,
          errorMessage:
            requestStatus > 0
              ? `${extensionFallback.error || "extension fallback failed"}`
              : extensionFallback.error || "fetch failed",
          errorName: requestStatus > 0 ? "HttpError" : "FetchError",
          transient,
          authFailure,
          rateLimit
      })
      return { ok: false }
    }
    bytes = extensionFallback.bytes
    contentType = extensionFallback.contentType
    requestStatus = extensionFallback.statusCode
  }

  if (!bytes || bytes.byteLength === 0) {
    clearPrefetchIntentForUrl(url)
    emitPrefetchFailure(url, {
      fetchPath: "originalFetch",
      status: requestStatus,
      errorMessage: "empty response",
      errorName: "EmptyResponse"
    })
    return { ok: false }
  }

  const bytesForStore =
    typeof ns.copyArrayBufferForBridge === "function"
      ? ns.copyArrayBufferForBridge(bytes)
      : bytes
  if (!bytesForStore || bytesForStore.byteLength === 0) {
    clearPrefetchIntentForUrl(url)
    emitPrefetchFailure(url, {
      fetchPath: "cache-store",
      status: requestStatus,
      errorMessage: "invalid-bytes-for-store",
      errorName: "StoreError"
    })
    return { ok: false }
  }

  // Send bytes to background for caching
  const storeRes = await storeChunkForPrefetch({
    url,
    contentType,
    bytes: bytesForStore,
    // Treat prefetch payload as full representation for this exact key.
    status: 200,
    method: "GET",
    hasRange: false,
    captureSource: "prefetch"
  })

  if (!storeRes?.ok) {
    clearPrefetchIntentForUrl(url)
    emitPrefetchFailure(url, {
      fetchPath: "cache-store",
      status: requestStatus,
      errorMessage: storeRes?.error ? `store failed: ${storeRes.error}` : "store failed",
      errorName: "StoreError",
      transient: isTransientStoreFailure(storeRes)
    })
    return { ok: false }
  }

  if (!isUrlGenerationCurrent(url)) {
    clearPrefetchIntentForUrl(url)
    emitPrefetchSkipped(url, "generation-stale")
    return { ok: false, skipped: "generation-stale" }
  }

  notifyRuntime("PREFETCH_RESULT", {
    url,
    success: true,
    size: bytes.byteLength,
    networkGeneration: pageNetworkGeneration
  })
  return {
    ok: true,
    bytes,
    contentType,
    status: requestStatus || 200
  }
  } catch (e) {
    if (e?.name === "AbortError" || controller.signal.aborted) {
      clearPrefetchIntentForUrl(url)
      emitPrefetchSkipped(url, "aborted")
      return { ok: false, aborted: true }
    }
    throw e
  } finally {
    prefetchAbortControllers.delete(url)
    urlQueuedGeneration.delete(url)
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
      if (e?.name === "AbortError") {
        clearPrefetchIntentForUrl(url)
        emitPrefetchSkipped(url, "aborted")
        return
      }
      if (!isUrlGenerationCurrent(url)) {
        clearPrefetchIntentForUrl(url)
        emitPrefetchSkipped(url, "generation-stale")
        return
      }
      const message = e?.message || "unknown"
      const name = e?.name || "Error"
      const transient = /failed to fetch|networkerror|load failed/i.test(
        String(message).toLowerCase()
      )
      clearPrefetchIntentForUrl(url)
      emitPrefetchFailure(url, {
        fetchPath: "originalFetch",
        status: 0,
        errorName: name,
        errorMessage: message,
        transient
      })
    } finally {
      activePrefetches.delete(url)
      urlQueuedGeneration.delete(url)
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

async function prefetchSegmentsFromPage(urls, options = {}) {
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) {
    return
  }
  const msgGen = Number(options.playbackGeneration ?? options.networkGeneration)
  pagePrefetchPriority = options.priority === "high" ? "high" : "low"
  if (Number.isFinite(msgGen)) {
    if (msgGen < pageNetworkGeneration) return
    const generationAdvanced = msgGen > pageNetworkGeneration
    pageNetworkGeneration = msgGen
    if (generationAdvanced) {
      cancelPrefetchRunway([], {
        networkGeneration: msgGen,
        reason: options.reason || "delegated-batch"
      })
    }
  } else if (options.append !== true) {
    cancelPrefetchRunway([], { reason: options.reason || "delegated-batch" })
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

  const now = Date.now()
  for (const url of toQueue) {
    notePrefetchIntentForUrl(url)
    queuedPrefetches.add(url)
    prefetchQueuedAt.set(url, now)
    urlQueuedGeneration.set(url, pageNetworkGeneration)
    prefetchQueue.push(url)
  }
  for (const url of skippedInflight) {
    notePrefetchIntentForUrl(url)
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
ns.cancelPrefetchRunway = cancelPrefetchRunway

})()
