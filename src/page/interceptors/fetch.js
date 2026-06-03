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
  isYoutubeVideoPlaybackUrl,
  isYoutubeInternalApiUrl,
  patchYoutubeInternalApiResponse,
  buildYoutubeUmpState,
  buildYoutubeChunkState,
  buildYoutubeChunkStateFromContentRange,
  buildYouTubePrefetchHeaders,
  cloneResponseForPlayer,
  createUmpProxyResponseAndCache,
  cacheNetworkStreamInBackground,
  storeChunkFromPage,
  copyArrayBufferForBridge,
  formatStoreChunkError,
  isLikelyChunk,
  isLikelyCacheHitCandidate,
  maybeCapturePlaylist,
  bodyToArrayBuffer,
  rememberKnownUmpKey,
  knownUmpCacheKeys,
  smoother
} = ns

const networkFetch = fetchWithCircuitBreaker || originalFetch
const UMP_STORE_RACE_RETRY_MS = 120
const EXTENSION_STREAM_META_TIMEOUT_MS = 8000

function scheduleImmediateFetchChunkCapture({
  response,
  url,
  method,
  youtubeChunk,
  requestHeaders,
  sourceUrl
}) {
  if (ns.extensionEnabled === false || ns.serveFromCache === false) return
  if (!response?.ok || !url || !response.body) return
  if (method !== "GET" && youtubeChunk?.type !== "ump") return

  const status = response.status
  if (
    !(
      status === 200 ||
      (status === 206 && youtubeChunk?.type === "bytes")
    )
  ) {
    return
  }

  let resolvedYoutubeChunk = youtubeChunk
  if (
    !resolvedYoutubeChunk &&
    isYoutubeVideoPlaybackUrl(url) &&
    status === 206
  ) {
    resolvedYoutubeChunk = buildYoutubeChunkStateFromContentRange(
      url,
      response.headers.get("content-range")
    )
  }

  const shouldCapture =
    isLikelyChunk(url) || Boolean(resolvedYoutubeChunk)
  if (!shouldCapture) return

  let cacheLookupUrl = url
  if (resolvedYoutubeChunk) {
    cacheLookupUrl = resolvedYoutubeChunk.cacheKey
  }

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
      const storeMethod = resolvedYoutubeChunk?.type === "ump" ? "GET" : method

      return storeChunkFromPage({
        url: cacheLookupUrl,
        contentType,
        bytes: bytesForStore,
        status: 200,
        method: storeMethod,
        hasRange: false,
        captureSource: "fetch-clone"
      })
        .then((storeRes) => {
          if (!storeRes?.ok && document.visibilityState === "visible") {
            logBridge(
              `Fetch immediate capture store failed (${formatStoreChunkError(storeRes)}): ${String(cacheLookupUrl).slice(-80)}`,
              "WARN"
            )
          }
          if (resolvedYoutubeChunk && resolvedYoutubeChunk.type !== "ump") {
            const prefetchHeaders = buildYouTubePrefetchHeaders(
              requestHeaders,
              resolvedYoutubeChunk,
              buffer.byteLength
            )
            window.AegisRangeBuffer?.triggerHeuristicPrefetch?.(
              sourceUrl || url,
              prefetchHeaders,
              ns.notifyRuntime,
              requestRuntime
            )
            globalThis.AegisYoutubeCrossItag?.maybeSpeculateFromPlayback?.(
              sourceUrl || url,
              resolvedYoutubeChunk
            )
          }
        })
        .catch(() => {})
    })
    .catch(() => {})
}

async function lookupCachedChunk(cacheLookupUrl, cacheLookupMethod, youtubeChunk) {
  if (
    typeof isLikelyCacheHitCandidate === "function" &&
    !isLikelyCacheHitCandidate(cacheLookupUrl)
  ) {
    return {
      lookup: { ok: true, hit: false, shortCircuit: true },
      lookupBytes: null
    }
  }

  let lookup = await Promise.race([
    requestRuntime("CACHE_LOOKUP_REQUEST", {
      url: cacheLookupUrl,
      method: cacheLookupMethod,
      hasRange: false
    }),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, hit: false, timeout: true }), 300))
  ])
  if (lookup?.timeout) {
    ns.reportRuntimeMetric("cache_lookup_timeout", { transport: "fetch", timeoutMs: 300 })
  }
  let lookupBytes = resolveLookupBytes(lookup)
  if (lookup?.ok && lookup.hit && lookupBytes) {
    return { lookup, lookupBytes }
  }

  if (youtubeChunk?.type === "ump" && youtubeChunk.bodyHash && !lookup?.hit) {
    const hashKey = `ump|${youtubeChunk.bodyHash}`
    if (hashKey !== cacheLookupUrl) {
      const hashLookup = await requestRuntime("CACHE_LOOKUP_REQUEST", {
        url: hashKey,
        method: cacheLookupMethod,
        hasRange: false
      })
      const hashBytes = resolveLookupBytes(hashLookup)
      if (hashLookup?.ok && hashLookup.hit && hashBytes) {
        logBridge(`UMP cache hit via body-hash key: ${youtubeChunk.bodyHash}`, "DEBUG")
        return { lookup: hashLookup, lookupBytes: hashBytes }
      }
    }
  }

  if (
    youtubeChunk?.type === "ump" &&
    knownUmpCacheKeys?.has?.(cacheLookupUrl)
  ) {
    await new Promise((resolve) => setTimeout(resolve, UMP_STORE_RACE_RETRY_MS))
    lookup = await requestRuntime("CACHE_LOOKUP_REQUEST", {
      url: cacheLookupUrl,
      method: cacheLookupMethod,
      hasRange: false
    })
    lookupBytes = resolveLookupBytes(lookup)
    if (lookup?.ok && lookup.hit && lookupBytes) {
      logBridge(`UMP cache hit after store race retry: ${cacheLookupUrl.slice(-48)}`, "DEBUG")
    }
  }

  return { lookup, lookupBytes }
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
  const { url, method, hasRange, requestHeaders } = getRequestDetails(input, init)
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

  if (method === "POST" && isYoutubeInternalApiUrl(url)) {
    const apiResponse = await networkFetch(input, init)
    return patchYoutubeInternalApiResponse(apiResponse)
  }

  let youtubeChunk = null
  const isYoutubePlayback = isYoutubeVideoPlaybackUrl(url)
  if (isYoutubePlayback) {
    globalThis.AegisYoutubeCrossItag?.recordTemplate?.(url)
    youtubeChunk = buildYoutubeChunkState(url, requestHeaders)
    if (!youtubeChunk && method === "POST") {
      youtubeChunk = await buildYoutubeUmpState(url, input, init)
    }

    if (youtubeChunk?.type === "bytes") {
      logBridge(
        `Intercepted YouTube byte-range via fetch: bytes ${youtubeChunk.start}-${youtubeChunk.end !== null ? youtubeChunk.end : "*"}`,
        "DEBUG"
      )
    } else if (youtubeChunk?.type === "sq") {
      logBridge(`Intercepted YouTube sequence via fetch: sq=${youtubeChunk.start}`, "DEBUG")
    } else if (youtubeChunk?.type === "ump") {
      logBridge(
        `Intercepted YouTube UMP POST via body hash: ${youtubeChunk.bodyHash} (${youtubeChunk.bodyLength} bytes)`,
        "DEBUG"
      )
      reportRuntimeMetric("youtube_ump_request", {
        bodyHash: youtubeChunk.bodyHash,
        bodyLength: youtubeChunk.bodyLength
      })
    } else if (hasRange) {
      logBridge(`YouTube fetch had Range header but parse failed: ${url.slice(0, 80)}`, "WARN")
    } else if (method === "POST") {
      logBridge(`YouTube POST videoplayback request had no hashable body: ${url.slice(0, 80)}`, "DEBUG")
    } else {
      logBridge(`YouTube videoplayback request had no range/sq identifier: ${url.slice(0, 80)}`, "DEBUG")
    }
  }

  const shouldInterceptGet = method === "GET" && url && (isLikelyChunk(url) || Boolean(youtubeChunk))
  const shouldInterceptPost = method === "POST" && youtubeChunk?.type === "ump"
  const shouldIntercept = shouldInterceptGet || shouldInterceptPost
  if (shouldIntercept && url) {
    notifyChunkObserved(url)
  }

  // For non-chunk GETs, let them through but watch for playlist responses
  if (!shouldIntercept || (hasRange && !youtubeChunk)) {
    const networkResponse = await networkFetch(input, init)

    // Check if the response is a playlist we should capture
    if (url && networkResponse.ok && !youtubeChunk) {
      try {
        const ct = networkResponse.headers.get("content-type") || ""
        maybeCapturePlaylist(url, ct, networkResponse.clone())
      } catch { /* ignore */ }
    }

    if (url && method === "GET" && isLikelyChunk(url)) {
      scheduleImmediateFetchChunkCapture({
        response: networkResponse,
        url,
        method,
        youtubeChunk: null,
        requestHeaders,
        sourceUrl: url
      })
    }

    return networkResponse
  }

  let cacheLookupUrl = url
  let cacheLookupMethod = method

  if (youtubeChunk) {
    cacheLookupUrl = youtubeChunk.cacheKey
    if (youtubeChunk.type === "ump") {
      // Background cache policies are GET-oriented; UMP keys are synthetic.
      cacheLookupMethod = "GET"
    }
  }

  // --- Chunk request: try cache-first ---
  try {
    const { lookup, lookupBytes } = await lookupCachedChunk(
      cacheLookupUrl,
      cacheLookupMethod,
      youtubeChunk
    )
    if (lookup?.ok && lookup.hit && lookupBytes) {
      if (youtubeChunk?.type === "ump") {
        rememberKnownUmpKey(cacheLookupUrl)
      }
      reportRuntimeMetric("request_first_byte", {
        source: "cache",
        transport: "fetch",
        streamType: youtubeChunk?.type || "generic",
        latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt))
      })

      const headers = new Headers({
        "content-type": lookup.contentType || "application/octet-stream",
        "x-aegisstream-cache": "HIT"
      })
      globalThis.AegisCacheResponseHeaders?.applyInstantSwitchCacheHeaders?.(headers)
      if (
        youtubeChunk?.type === "bytes" &&
        Number.isFinite(youtubeChunk.start)
      ) {
        const actualEnd = Number.isFinite(youtubeChunk.end)
          ? youtubeChunk.end
          : youtubeChunk.start + lookupBytes.byteLength - 1
        headers.set("content-range", `bytes ${youtubeChunk.start}-${actualEnd}/*`)
        return new Response(lookupBytes, { status: 206, headers })
      }
      return new Response(lookupBytes, { status: 200, headers })
    }
  } catch {
    // Fall through to network
  }

  let networkResponse
  let chunkCacheCaptureHandled = false
  try {
    let headersObj = {};
    if (requestHeaders) {
      for (const [k, v] of requestHeaders.entries()) {
        headersObj[k] = v;
      }
    }

    let bodyBytes = null;
    if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
      bodyBytes = await bodyToArrayBuffer(init.body);
    } else if (input instanceof Request) {
      try {
        bodyBytes = await input.clone().arrayBuffer();
      } catch {
        bodyBytes = null;
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
  if (youtubeChunk?.type !== "ump") {
    reportRuntimeMetric("request_first_byte", {
      source: "network",
      transport: "fetch",
      streamType: youtubeChunk?.type || "generic",
      latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt))
    })
  }

  // Opportunistically cache the chunk response
  try {
    if (
      !youtubeChunk &&
      isYoutubePlayback &&
      networkResponse.status === 206
    ) {
      const recovered = buildYoutubeChunkStateFromContentRange(
        url,
        networkResponse.headers.get("content-range")
      )
      if (recovered) {
        youtubeChunk = recovered
        cacheLookupUrl = recovered.cacheKey
        logBridge(
          `Recovered YouTube byte-range from response header: bytes ${recovered.start}-${recovered.end}`,
          "DEBUG"
        )
      }
    }

    if (
      networkResponse.ok &&
      (
        method === "POST" ||
        networkResponse.status === 200 ||
        (networkResponse.status === 206 && youtubeChunk?.type === "bytes")
      )
    ) {
      const contentType =
        networkResponse.headers.get("content-type") || "application/octet-stream"

      if (youtubeChunk?.type === "ump" && networkResponse.body) {
        chunkCacheCaptureHandled = true
        return createUmpProxyResponseAndCache({
          networkResponse,
          cacheLookupUrl,
          contentType,
          urlForLog: cacheLookupUrl,
          captureForCache: true,
          requestStartedAt
        })
      }

      if (networkResponse.body) {
        const [playerStream, cacheStream] = networkResponse.body.tee()
        const playerResponse = cloneResponseForPlayer(networkResponse, playerStream)

        cacheNetworkStreamInBackground({
          stream: cacheStream,
          cacheLookupUrl,
          contentType,
          storeMethod: youtubeChunk?.type === "ump" ? "GET" : method,
          urlForLog: cacheLookupUrl,
          youtubeChunk,
          requestHeaders,
          sourceUrl: url
        })

        chunkCacheCaptureHandled = true
        return playerResponse
      }
    }
  } catch {
    // Ignore store failures
  }

  if (!chunkCacheCaptureHandled && shouldIntercept) {
    scheduleImmediateFetchChunkCapture({
      response: networkResponse,
      url,
      method,
      youtubeChunk,
      requestHeaders,
      sourceUrl: url
    })
  }
  return networkResponse
}

function installFetchInterceptor() {
  window.fetch = aegisFetch
}

ns.installFetchInterceptor = installFetchInterceptor
})()
