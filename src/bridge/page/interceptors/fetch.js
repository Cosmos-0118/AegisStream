(() => {
var ns = (self.AegisPageBridge ||= {})
const {
  originalFetch,
  getRequestDetails,
  requestRuntime,
  resolveLookupBytes,
  logBridge,
  monotonicNow,
  reportRuntimeMetric,
  notifyChunkObserved,
  isYoutubeVideoPlaybackUrl,
  buildYoutubeUmpState,
  buildYoutubeChunkState,
  buildYoutubeChunkStateFromContentRange,
  buildYouTubePrefetchHeaders,
  cloneResponseForPlayer,
  createUmpProxyResponseAndCache,
  cacheNetworkStreamInBackground,
  isLikelyChunk,
  maybeCapturePlaylist,
  bodyToArrayBuffer,
  rememberKnownUmpKey
} = ns

async function aegisFetch(input, init) {
  const { url, method, hasRange, requestHeaders } = getRequestDetails(input, init)
  const requestStartedAt = monotonicNow()

  let youtubeChunk = null
  const isYoutubePlayback = isYoutubeVideoPlaybackUrl(url)
  if (isYoutubePlayback) {
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
    const networkResponse = await originalFetch(input, init)

    // Check if the response is a playlist we should capture
    if (url && networkResponse.ok && !youtubeChunk) {
      try {
        const ct = networkResponse.headers.get("content-type") || ""
        maybeCapturePlaylist(url, ct, networkResponse.clone())
      } catch { /* ignore */ }
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
    const lookup = await requestRuntime("CACHE_LOOKUP_REQUEST", {
      url: cacheLookupUrl,
      method: cacheLookupMethod,
      hasRange: false // We bypass strict hasRange check in SW for range buffer keys
    })
    const lookupBytes = resolveLookupBytes(lookup)
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

  let networkResponse;
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

    logBridge(`Delegating fetch to Native Daemon: ${url.slice(0, 80)}`, "DEBUG");
    const daemonRes = await requestRuntime("DAEMON_FETCH_REQUEST", {
      url,
      method,
      headers: headersObj,
      bytes: bodyBytes
    });

    if (daemonRes && daemonRes.ok && daemonRes.statusCode) {
      const respHeaders = new Headers(daemonRes.headers);
      const uint8Bytes = daemonRes.bytes ? new Uint8Array(daemonRes.bytes) : null;
      networkResponse = new Response(uint8Bytes, {
        status: daemonRes.statusCode,
        statusText: daemonRes.statusCode === 206 ? "Partial Content" : "OK",
        headers: respHeaders
      });
    } else {
      logBridge(`Native Daemon fetch failed (${daemonRes?.error || 'unknown'}), falling back`, "WARN");
      networkResponse = await originalFetch(input, init);
    }
  } catch (e) {
    logBridge(`Native Daemon fetch error (${e.message}), falling back`, "WARN");
    networkResponse = await originalFetch(input, init);
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

        return playerResponse
      }
    }
  } catch {
    // Ignore store failures
  }
  return networkResponse
}

function installFetchInterceptor() {
  window.fetch = aegisFetch
}

ns.installFetchInterceptor = installFetchInterceptor
})()
