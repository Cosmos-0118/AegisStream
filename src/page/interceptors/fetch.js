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
  smoother
} = ns

const networkFetch = fetchWithCircuitBreaker || originalFetch
const EXTENSION_STREAM_META_TIMEOUT_MS = 8000

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

async function lookupCachedChunk(cacheLookupUrl, cacheLookupMethod) {
  // Registry trust decay (P4): "absent" is a confidence signal, not an oracle.
  // A low-confidence verdict shortens the lookup budget instead of skipping
  // the lookup entirely — a small IPC is always cheaper than a wrong miss.
  const isCandidate =
    typeof isLikelyCacheHitCandidate !== "function" ||
    isLikelyCacheHitCandidate(cacheLookupUrl)
  const timeoutMs = isCandidate ? 2_000 : 1_200

  let lookup = await Promise.race([
    requestRuntime("CACHE_LOOKUP_REQUEST", {
      url: cacheLookupUrl,
      method: cacheLookupMethod,
      hasRange: false
    }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, hit: false, timeout: true }), timeoutMs))
  ])
  if (lookup?.timeout) {
    ns.reportRuntimeMetric("cache_lookup_timeout", { transport: "fetch", timeoutMs })
  }
  const lookupBytes = resolveLookupBytes(lookup)
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
        cacheLookupMethod
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
    return originalFetch(input, init)
  }
}

async function aegisFetchInner(input, init) {
  const { url, method, requestHeaders } = getRequestDetails(input, init)
  const requestStartedAt = monotonicNow()

  if (ns.extensionEnabled === false) {
    return originalFetch(input, init)
  }

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

  const shouldIntercept =
    method === "GET" && url && isLikelyChunk(url) && !isPlaylistUrl(url)
  if (shouldIntercept && url) {
    notifyChunkObserved(url)
  }

  if (!shouldIntercept) {
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

  try {
    const { lookup, lookupBytes } = await lookupCachedChunk(cacheLookupUrl, cacheLookupMethod)
    if (lookup?.ok && lookup.hit && lookupBytes) {
      if (typeof ns.noteLocalCacheKey === "function") {
        ns.noteLocalCacheKey(cacheLookupUrl)
      }
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
  } catch {
    // Fall through to network
  }

  try {
    const collapsedResponse = await tryCollapseOntoInflightPrefetch({
      url,
      cacheLookupUrl,
      cacheLookupMethod,
      requestStartedAt
    })
    if (collapsedResponse) {
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
