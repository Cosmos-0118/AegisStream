(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("fetch-interceptor")) {
  return
}

const {
  originalFetch,
  fetchWithCircuitBreaker,
  getRequestDetails,
  requestRuntime,
  requestExtensionFetchStream,
  resolveLookupBytes,
  logBridge,
  monotonicNow,
  reportRuntimeMetric,
  notifyChunkObserved,
  storeChunkFromPage,
  copyArrayBufferForBridge,
  formatStoreChunkError,
  isLikelyChunk,
  isPlaylistUrl,
  isLikelyCacheHitCandidate,
  maybeCapturePlaylist,
  bodyToArrayBuffer,
  cloneResponseForPlayer,
  cacheNetworkStreamInBackground,
  smoother,
  clearCacheState,
  currentVideoFingerprint,
  rememberVideoFingerprint,
  resolveVideoFingerprint
} = ns

const networkFetch = fetchWithCircuitBreaker || originalFetch
const EXTENSION_STREAM_META_TIMEOUT_MS = 8000
const CACHE_DIAGNOSTIC_WINDOW_MS = 10_000
let lastCacheDiagnosticAt = 0

function shouldLogCacheDiagnostics() {
  const now = Date.now()
  if (now - lastCacheDiagnosticAt < CACHE_DIAGNOSTIC_WINDOW_MS) return false
  lastCacheDiagnosticAt = now
  return true
}

function logCacheDiagnostics(event, data = {}) {
  if (!shouldLogCacheDiagnostics()) return
  logBridge(`[cache-diagnostics] ${event} ${JSON.stringify(data)}`, "DEBUG")
}

function noteCacheTelemetry(metric, amount = 1) {
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity(metric, amount)
  }
}

function noteCacheDiagnosticCounter(metric, amount = 1) {
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity(metric, amount)
  }
}

function scheduleImmediateFetchChunkCapture({ response, url, method }) {
  if (ns.extensionEnabled === false || ns.serveFromCache === false) return
  if (!response?.ok || !url || !response.body) return
  if (method !== "GET" || response.status !== 200) return
  if (!isLikelyChunk(url)) return

  let cloned
  try {
    cloned = response.clone()
  } catch {
    return
  }

  void cloned
    .arrayBuffer()
    .then((buffer) => {
      if (!buffer || buffer.byteLength === 0) return
      const bytesForStore =
        typeof copyArrayBufferForBridge === "function"
          ? copyArrayBufferForBridge(buffer)
          : null
      if (!bytesForStore) return

      const contentType =
        response.headers.get("content-type") || "application/octet-stream"

      return storeChunkFromPage({
        url,
        contentType,
        bytes: bytesForStore,
        status: 200,
        method,
        hasRange: false,
        captureSource: "fetch-clone"
      }).then((storeRes) => {
        if (!storeRes?.ok && document.visibilityState === "visible") {
          logBridge(
            `Fetch immediate capture store failed (${formatStoreChunkError(storeRes)}): ${String(url).slice(-80)}`,
            "WARN"
          )
        }
      }).catch(() => {})
    })
    .catch(() => {})
}

async function lookupCachedChunk(cacheLookupUrl, cacheLookupMethod, hasRange = false, options = {}) {
  // Registry trust decay (P4): "absent" is a confidence signal, not an oracle.
  // A low-confidence verdict shortens the lookup budget instead of skipping
  // the lookup entirely — a small IPC is always cheaper than a wrong miss.
  const isCandidate =
    hasRange ||
    typeof isLikelyCacheHitCandidate !== "function" ||
    isLikelyCacheHitCandidate(cacheLookupUrl)
  const timeoutMs = isCandidate ? 2_000 : 1_200
  const aggressive = options.aggressive === true
  const extraWaitMs = aggressive ? 650 : 0

  logCacheDiagnostics("lookup-start", {
    url: String(cacheLookupUrl || "").slice(-96),
    method: cacheLookupMethod,
    hasRange,
    candidate: isCandidate,
    aggressive
  })
  noteCacheTelemetry("cacheLookups", 1)

  const runLookup = async (waitMs) => {
    const lookup = await Promise.race([
      requestRuntime("CACHE_LOOKUP_REQUEST", {
        url: cacheLookupUrl,
        method: cacheLookupMethod,
        hasRange
      }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, hit: false, timeout: true }), waitMs))
    ])
    if (lookup?.timeout) {
      ns.reportRuntimeMetric("cache_lookup_timeout", { transport: "fetch", timeoutMs: waitMs })
    }
    return lookup
  }

  let lookup = await runLookup(timeoutMs)
  let lookupBytes = resolveLookupBytes(lookup)
  if ((!lookup?.ok || lookup?.hit !== true || !lookupBytes) && aggressive && extraWaitMs > 0) {
    logCacheDiagnostics("lookup-retry", {
      url: String(cacheLookupUrl || "").slice(-96),
      waitMs: extraWaitMs,
      range: hasRange
    })
    const retryLookup = await runLookup(extraWaitMs)
    const retryBytes = resolveLookupBytes(retryLookup)
    if (retryLookup?.ok && retryLookup.hit && retryBytes) {
      lookup = retryLookup
      lookupBytes = retryBytes
    }
  }

  logCacheDiagnostics("lookup-result", {
    url: String(cacheLookupUrl || "").slice(-96),
    ok: lookup?.ok === true,
    hit: lookup?.hit === true,
    timeout: lookup?.timeout === true,
    fromCache: lookup?.fromCache === true,
    bytes: lookupBytes?.byteLength || 0,
    aggressive
  })
  if (lookup?.hit && lookupBytes) noteCacheTelemetry("cacheHits", 1)
  else if (lookup?.ok && lookup?.hit === false) noteCacheTelemetry("cacheMisses", 1)
  if (lookup?.hit && hasRange) noteCacheDiagnosticCounter("rangeCacheHits", 1)
  if (hasRange && lookup?.ok && !lookup?.hit) noteCacheDiagnosticCounter("rangeCacheMisses", 1)
  if (!isCandidate && lookup?.ok && lookup.hit && lookupBytes) {
    // Registry said absent but the lookup hit — decay registry trust.
    if (typeof ns.noteRegistryFalseNegative === "function") {
      ns.noteRegistryFalseNegative()
    }
  }
  return { lookup, lookupBytes }
}

function buildChunkResponseFromBytes(lookupBytes, lookup) {
  const headers = new Headers({
    "content-type": lookup?.contentType || "application/octet-stream",
    "x-aegisstream-cache": lookup?.fromCache ? "HIT" : "COLLAPSED"
  })
  globalThis.AegisCacheResponseHeaders?.applyInstantSwitchCacheHeaders?.(headers)
  return new Response(lookupBytes, { status: 200, headers })
}

async function shouldAttemptRequestCollapse(url, cacheLookupUrl) {
  // Queued-but-not-started prefetch: start it now and join its wire instead
  // of opening a duplicate socket for bytes the worker was about to fetch.
  if (
    typeof ns.demandStartQueuedPrefetch === "function" &&
    ns.demandStartQueuedPrefetch(url, cacheLookupUrl)
  ) {
    return true
  }
  if (
    typeof ns.isNetworkFetchInflight === "function" &&
    ns.isNetworkFetchInflight(url, cacheLookupUrl)
  ) {
    return true
  }
  try {
    const query = await requestRuntime("INFLIGHT_PREFETCH_QUERY", {
      url: cacheLookupUrl || url
    })
    return query?.inflight === true
  } catch {
    return false
  }
}

function shouldPreferCacheForPlayerRequest(url, method, requestHeaders) {
  if (method !== "GET" || !url) return false
  if (typeof globalThis.AegisSitePolicy?.shouldPassthroughPlayerRequest === "function") {
    try {
      if (globalThis.AegisSitePolicy.shouldPassthroughPlayerRequest(url)) return false
    } catch {
      // ignore policy failure
    }
  }
  const sourceHint = String(requestHeaders?.get?.("x-aegis-source") || "").toLowerCase()
  const rangeHeader = requestHeaders?.get?.("range")
  if (sourceHint.includes("player") || sourceHint.includes("buffer") || rangeHeader) return true
  return typeof isLikelyChunk === "function" && isLikelyChunk(url)
}

function shouldAggressivelyPrefetchForRequest(url, requestHeaders) {
  if (!url) return false
  const rangeHeader = String(requestHeaders?.get?.("range") || "")
  const sourceHint = String(requestHeaders?.get?.("x-aegis-source") || "").toLowerCase()
  // Only escalate when the request is already playback-critical. Broad player
  // hints can over-trigger and compete with the media element on weaker devices.
  return Boolean(rangeHeader || sourceHint.includes("buffer"))
}

function maybeResetCacheForNewVideo(url) {
  if (typeof resolveVideoFingerprint !== "function" || typeof rememberVideoFingerprint !== "function") {
    return false
  }
  const fingerprint = resolveVideoFingerprint(url)
  if (!fingerprint) return false
  const current = typeof currentVideoFingerprint === "function" ? currentVideoFingerprint() : null
  if (current && current !== fingerprint) {
    logCacheDiagnostics("video-change-reset", {
      previous: String(current).slice(-32),
      next: String(fingerprint).slice(-32),
      url: String(url || "").slice(-96)
    })
    noteCacheTelemetry("videoFingerprintResets", 1)
    if (typeof clearCacheState === "function") {
      clearCacheState({ reason: "new-video", fingerprint })
    }
    if (typeof ns.clearDiagnosticsForVideo === "function") {
      ns.clearDiagnosticsForVideo(fingerprint)
    }
    rememberVideoFingerprint(fingerprint)
    return true
  }
  if (!current) {
    rememberVideoFingerprint(fingerprint)
  }
  return false
}

async function tryCollapseOntoInflightPrefetch({
  url,
  cacheLookupUrl,
  cacheLookupMethod,
  requestStartedAt
}) {
  if (typeof ns.awaitCollapsedNetworkDelivery !== "function") return null
  if (!(await shouldAttemptRequestCollapse(url, cacheLookupUrl))) return null

  logBridge(
    `Request collapse: awaiting in-flight prefetch for ${String(cacheLookupUrl || url).slice(-48)}`,
    "DEBUG"
  )
  reportRuntimeMetric("request_collapse_attempt", {
    transport: "fetch",
    streamType: "hls"
  })

  const collapsed = await ns.awaitCollapsedNetworkDelivery(
    url,
    cacheLookupUrl,
    async () => {
      const { lookup, lookupBytes } = await lookupCachedChunk(
        cacheLookupUrl,
        cacheLookupMethod,
        false,
        { aggressive: true }
      )
      if (lookup?.ok && lookup.hit && lookupBytes) {
        return {
          ok: true,
          bytes: lookupBytes,
          contentType: lookup.contentType,
          status: 200,
          fromCache: true
        }
      }
      return { ok: false }
    },
    {
      timeoutMs:
        typeof ns.resolveCollapseWaitTimeoutMs === "function"
          ? ns.resolveCollapseWaitTimeoutMs()
          : 8_000,
      pollMs: 60
    }
  )

  if (!collapsed?.ok || !collapsed.bytes) return null

  const savedBytes =
    collapsed.bytes && typeof collapsed.bytes.byteLength === "number"
      ? collapsed.bytes.byteLength
      : 0
  reportRuntimeMetric("request_collapse_hit", {
    transport: "fetch",
    streamType: "hls",
    latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt)),
    fromCache: collapsed.fromCache === true,
    savedBytes
  })
  if (collapsed.fromCache === true && typeof ns.noteLocalCacheKey === "function") {
    ns.noteLocalCacheKey(cacheLookupUrl)
  }
  return buildChunkResponseFromBytes(collapsed.bytes, collapsed)
}

async function aegisFetch(input, init) {
  try {
    return await aegisFetchInner(input, init)
  } catch (e) {
    logBridge(`aegisFetch critical error (${e?.message || "unknown"}), bypassing to native fetch`, "ERROR")
    try {
      return await originalFetch(input, init)
    } catch (fallbackError) {
      logBridge(
        `native fetch fallback failed (${fallbackError?.message || "unknown"})`,
        "ERROR"
      )
      throw fallbackError
    }
  }
}

async function aegisFetchInner(input, init) {
  const { url, method, requestHeaders } = getRequestDetails(input, init)
  const requestStartedAt = monotonicNow()

  if (ns.extensionEnabled === false) {
    return originalFetch(input, init)
  }

  if (url && maybeResetCacheForNewVideo(url)) {
    reportRuntimeMetric("cache_reset", { reason: "new-video" })
  }
  logCacheDiagnostics("request-observed", {
    url: String(url || "").slice(-96),
    method,
    contentType: String(requestHeaders?.get?.("accept") || "").slice(0, 48),
    range: Boolean(requestHeaders?.get?.("range"))
  })

  if (url && globalThis.AegisSitePolicy?.shouldPassthroughPlayerRequest?.(url)) {
    return originalFetch(input, init)
  }

  if (url && typeof smoother?.isSiteApiPath === "function") {
    try {
      if (smoother.isSiteApiPath(new URL(url, location.href).pathname)) {
        return originalFetch(input, init)
      }
    } catch {
      // ignore
    }
  }

  const shouldIntercept = method === "GET" && url && isLikelyChunk(url) && !isPlaylistUrl(url)
  const shouldPreferCache = shouldPreferCacheForPlayerRequest(url, method, requestHeaders)
  const shouldAggressivePrefetch = shouldAggressivelyPrefetchForRequest(url, requestHeaders)
  if ((shouldIntercept || shouldPreferCache) && url) {
    notifyChunkObserved(url)
  }
  if (shouldAggressivePrefetch && typeof ns.bumpActivity === "function") {
    ns.bumpActivity("playerBufferRequests", 1)
  }

  if (!shouldIntercept && !shouldPreferCache) {
    const networkResponse = await networkFetch(input, init)

    if (url && networkResponse.ok) {
      try {
        const ct = networkResponse.headers.get("content-type") || ""
        maybeCapturePlaylist(url, ct, networkResponse.clone())
      } catch { /* ignore */ }
    }

    return networkResponse
  }

  const cacheLookupUrl = url
  const cacheLookupMethod = method
  const requestHasRange = Boolean(requestHeaders?.get?.("range"))

  try {
    const { lookup, lookupBytes } = await lookupCachedChunk(
      cacheLookupUrl,
      cacheLookupMethod,
      requestHasRange,
      { aggressive: shouldAggressivePrefetch }
    )
    if (lookup?.ok && lookup.hit && lookupBytes) {
      if (typeof ns.noteLocalCacheKey === "function") {
        ns.noteLocalCacheKey(cacheLookupUrl)
      }
      logCacheDiagnostics("cache-hit-serve", {
        url: String(cacheLookupUrl || "").slice(-96),
        range: requestHasRange,
        bytes: lookupBytes.byteLength || 0,
        contentType: lookup.contentType || "application/octet-stream"
      })
      noteCacheTelemetry("cacheServes", 1)
      reportRuntimeMetric("request_first_byte", {
        source: "cache",
        transport: "fetch",
        streamType: "hls",
        latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt))
      })

      const headers = new Headers({
        "content-type": lookup.contentType || "application/octet-stream",
        "x-aegisstream-cache": "HIT"
      })
      globalThis.AegisCacheResponseHeaders?.applyInstantSwitchCacheHeaders?.(headers)
      return new Response(lookupBytes, { status: 200, headers })
    }
    logCacheDiagnostics("cache-miss-serve", {
      url: String(cacheLookupUrl || "").slice(-96),
      range: requestHasRange,
      shouldIntercept,
      shouldPreferCache
    })
    noteCacheTelemetry("cacheFallbacks", 1)
    if (requestHasRange) noteCacheDiagnosticCounter("rangeFallbacks", 1)
  } catch {
    // Fall through to network
  }

  try {
    if (shouldAggressivePrefetch && typeof ns.noteLocalCacheKey === "function") {
      ns.noteLocalCacheKey(cacheLookupUrl)
    }
    const collapsedResponse = await tryCollapseOntoInflightPrefetch({
      url,
      cacheLookupUrl,
      cacheLookupMethod,
      requestStartedAt
    })
    if (collapsedResponse) {
      logCacheDiagnostics("collapse-hit-serve", {
        url: String(cacheLookupUrl || url || "").slice(-96),
        range: requestHasRange,
        bytes:
          collapsedResponse?.headers?.get?.("content-length") ||
          collapsedResponse?.body ? 1 : 0
      })
      reportRuntimeMetric("request_first_byte", {
        source: "collapse",
        transport: "fetch",
        streamType: "hls",
        latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt))
      })
      return collapsedResponse
    }
  } catch {
    // Fall through to extension/native fetch
  }

  if (shouldAggressivePrefetch && typeof ns.requestPrefetchBoost === "function") {
    try {
      ns.requestPrefetchBoost({
        url: cacheLookupUrl,
        method: cacheLookupMethod,
        reason: requestHasRange ? "player-range" : "player-buffer",
        urgent: requestHasRange === true
      })
    } catch {
      // ignore boost failures
    }
  }

  let networkResponse
  let chunkCacheCaptureHandled = false
  try {
    const headersObj = {}
    if (requestHeaders) {
      for (const [k, v] of requestHeaders.entries()) {
        headersObj[k] = v
      }
    }

    let bodyBytes = null
    if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
      bodyBytes = await bodyToArrayBuffer(init.body)
    } else if (input instanceof Request) {
      try {
        bodyBytes = await input.clone().arrayBuffer()
      } catch {
        bodyBytes = null
      }
    }

    logBridge(`Extension fetch stream: ${url.slice(0, 80)}`, "DEBUG")
    const { stream, meta } = requestExtensionFetchStream({
      url,
      method,
      headers: headersObj,
      bytes: bodyBytes,
      source: "player-fetch"
    })

    try {
      const extensionMeta = await Promise.race([
        meta,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("extension-stream-meta-timeout")), EXTENSION_STREAM_META_TIMEOUT_MS)
        )
      ])
      networkResponse = new Response(stream, {
        status: extensionMeta.statusCode,
        statusText: extensionMeta.statusCode === 206 ? "Partial Content" : "OK",
        headers: new Headers(extensionMeta.headers)
      })
    } catch (streamErr) {
      logBridge(
        `Extension fetch failed (${streamErr?.message || "unknown"}), falling back to native fetch`,
        "WARN"
      )
      try {
        stream.cancel().catch((err) => {
          if (err?.name !== "AbortError") {
            logBridge(`Stream cancel failed: ${err?.message || err}`, "WARN")
          }
        })
      } catch {}
      networkResponse = await originalFetch(input, init)
    }
  } catch (e) {
    logBridge(`Extension fetch error (${e.message}), falling back`, "WARN")
    networkResponse = await networkFetch(input, init)
  }

  reportRuntimeMetric("request_first_byte", {
    source: "network",
    transport: "fetch",
    streamType: "hls",
    latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt))
  })

  try {
    if (
      networkResponse.ok &&
      (networkResponse.status === 200 || networkResponse.status === 206) &&
      networkResponse.body
    ) {
      const contentType =
        networkResponse.headers.get("content-type") || "application/octet-stream"
      const [playerStream, cacheStream] = networkResponse.body.tee()
      const playerResponse = cloneResponseForPlayer(networkResponse, playerStream)

      cacheNetworkStreamInBackground({
        stream: cacheStream,
        cacheLookupUrl,
        contentType,
        storeMethod: method,
        urlForLog: cacheLookupUrl
      })

      chunkCacheCaptureHandled = true
      return playerResponse
    }
  } catch {
    // Ignore store failures
  }

  if (!chunkCacheCaptureHandled && shouldIntercept) {
    scheduleImmediateFetchChunkCapture({
      response: networkResponse,
      url,
      method
    })
  }
  return networkResponse
}

function installFetchInterceptor() {
  window.fetch = aegisFetch
}

ns.installFetchInterceptor = installFetchInterceptor
})()
