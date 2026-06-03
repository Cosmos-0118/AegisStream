(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("xhr-interceptor")) {
  return
}

const {
  OriginalXHR,
  fetchWithCircuitBreaker,
  originalFetch,
  stripHash,
  requestRuntime,
  resolveLookupBytes,
  logBridge,
  notifyRuntime,
  notifyChunkObserved,
  isYoutubeVideoPlaybackUrl,
  buildYoutubeChunkState,
  buildYoutubeChunkStateFromContentRange,
  buildYouTubePrefetchHeaders,
  isLikelyChunk,
  isPlaylistUrl,
  isPlaylistContentType,
  looksLikePlaylistBody,
  canRelayPlaylist,
  markPlaylistRelayed,
  smoother
} = ns

const networkFetch = fetchWithCircuitBreaker || originalFetch

function synthesizeXhrFromBuffer(xhr, statusCode, statusText, bytes, contentType, extraHeaders = {}) {
  Object.defineProperty(xhr, "status", { get: () => statusCode, configurable: true })
  Object.defineProperty(xhr, "statusText", { get: () => statusText, configurable: true })
  Object.defineProperty(xhr, "readyState", { get: () => 4, configurable: true })
  Object.defineProperty(xhr, "response", { get: () => bytes, configurable: true })
  Object.defineProperty(xhr, "responseText", {
    get: () => {
      try {
        return new TextDecoder().decode(bytes)
      } catch {
        return ""
      }
    },
    configurable: true
  })
  Object.defineProperty(xhr, "getResponseHeader", {
    value: (name) => {
      const lower = name.toLowerCase()
      if (lower === "content-type") return contentType
      if (lower === "x-aegisstream-cache") return extraHeaders["x-aegisstream-cache"] || null
      return extraHeaders[lower] || null
    },
    configurable: true,
    writable: true
  })
  Object.defineProperty(xhr, "getAllResponseHeaders", {
    value: () => {
      let headers = `content-type: ${contentType}\r\n`
      for (const [key, value] of Object.entries(extraHeaders)) {
        if (value != null) headers += `${key}: ${value}\r\n`
      }
      return headers
    },
    configurable: true,
    writable: true
  })
  xhr.dispatchEvent(new Event("readystatechange"))
  xhr.dispatchEvent(new Event("load"))
  xhr.dispatchEvent(new Event("loadend"))
}

function AegisXHR() {
  const xhr = new OriginalXHR()
  let _method = "GET"
  let _url = null
  let _hasRange = false
  let _rangeHeaderValue = null

  const originalOpen = xhr.open.bind(xhr)
  xhr.open = function (method, url, ...args) {
    _method = (method || "GET").toUpperCase()
    try {
      _url = stripHash(new URL(url, location.href).toString())
    } catch {
      _url = stripHash(url)
    }
    return originalOpen(method, url, ...args)
  }

  const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr)
  xhr.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === "range") {
      _hasRange = true
      _rangeHeaderValue = value
    }
    return originalSetRequestHeader(name, value)
  }

  const originalSend = xhr.send.bind(xhr)
  xhr.send = function (body) {
    if (ns.extensionEnabled === false) {
      return originalSend(body)
    }

    if (_url && globalThis.AegisSitePolicy?.shouldPassthroughPlayerRequest?.(_url)) {
      return originalSend(body)
    }

    const isSiteApi =
      _url &&
      typeof smoother?.isSiteApiPath === "function" &&
      (() => {
        try {
          return smoother.isSiteApiPath(new URL(_url, location.href).pathname)
        } catch {
          return false
        }
      })()

    if (isSiteApi) {
      return originalSend(body)
    }

    const requestRangeHeaders = new Headers()
    if (_rangeHeaderValue) {
      requestRangeHeaders.set("Range", _rangeHeaderValue)
    }

    let youtubeChunk = null
    if (isYoutubeVideoPlaybackUrl(_url)) {
      youtubeChunk = buildYoutubeChunkState(_url, requestRangeHeaders)
      if (youtubeChunk?.type === "bytes") {
        logBridge(
          `Intercepted YouTube byte-range via XHR: bytes ${youtubeChunk.start}-${youtubeChunk.end !== null ? youtubeChunk.end : "*"}`,
          "DEBUG"
        )
      } else if (youtubeChunk?.type === "sq") {
        logBridge(`Intercepted YouTube sequence via XHR: sq=${youtubeChunk.start}`, "DEBUG")
      } else if (_hasRange) {
        logBridge(`YouTube XHR had Range header but parse failed: ${_url.slice(0, 80)}`, "WARN")
      } else {
        logBridge(`YouTube videoplayback request via XHR had no range/sq identifier: ${_url.slice(0, 80)}`, "DEBUG")
      }
    }

    // Always attach a load listener to capture playlist responses from XHR
    xhr.addEventListener("load", function xhrLoadHandler() {
      try {
        if (xhr.status >= 200 && xhr.status < 300 && _url) {
          const ct = xhr.getResponseHeader("content-type") || ""

          // Check for playlist content
          if (isPlaylistUrl(_url) || isPlaylistContentType(ct)) {
            let text = null
            if (typeof xhr.responseText === "string") {
              text = xhr.responseText
            } else if (xhr.response && typeof xhr.response === "string") {
              text = xhr.response
            }
            if (text && looksLikePlaylistBody(text)) {
              if (canRelayPlaylist(_url)) {
                markPlaylistRelayed(_url)
                if (ns.extensionEnabled !== false) {
                  notifyRuntime("PLAYLIST_CONTENT", { url: _url, text })
                }
              }
            }
          }

          let responseYoutubeChunk = youtubeChunk
          if (!responseYoutubeChunk && isYoutubeVideoPlaybackUrl(_url) && xhr.status === 206) {
            const recovered = buildYoutubeChunkStateFromContentRange(
              _url,
              xhr.getResponseHeader("content-range")
            )
            if (recovered) {
              responseYoutubeChunk = recovered
              youtubeChunk = recovered
              logBridge(
                `Recovered YouTube byte-range from XHR response header: bytes ${recovered.start}-${recovered.end}`,
                "DEBUG"
              )
            }
          }

          const shouldIntercept =
            _method === "GET" && _url && (isLikelyChunk(_url) || Boolean(responseYoutubeChunk))

          if (
            shouldIntercept &&
            (xhr.status === 200 || (xhr.status === 206 && responseYoutubeChunk?.type === "bytes"))
          ) {
            let bytes = null
            if (xhr.response instanceof ArrayBuffer) {
              bytes = xhr.response
            } else if (typeof xhr.response === "string") {
              bytes = new TextEncoder().encode(xhr.response).buffer
            }
            if (bytes && bytes.byteLength > 0) {
              let cacheLookupUrl = _url

              if (responseYoutubeChunk) {
                cacheLookupUrl = responseYoutubeChunk.cacheKey
                const prefetchHeaders = buildYouTubePrefetchHeaders(
                  requestRangeHeaders,
                  responseYoutubeChunk,
                  bytes.byteLength
                )
                window.AegisRangeBuffer.triggerHeuristicPrefetch(
                  _url,
                  prefetchHeaders,
                  notifyRuntime,
                  requestRuntime
                )
              }

              if (ns.extensionEnabled !== false && ns.serveFromCache !== false) {
                requestRuntime("STORE_CHUNK_REQUEST", {
                  url: cacheLookupUrl,
                  contentType: ct,
                  bytes,
                  status: 200,
                  method: _method,
                  hasRange: false
                }).catch(() => {})
              }
            }
          }
        }
      } catch {
        // Ignore errors in the handler
      }
    })

    const shouldIntercept =
      ns.extensionEnabled !== false &&
      _method === "GET" &&
      _url &&
      (isLikelyChunk(_url) || Boolean(youtubeChunk))
    if (shouldIntercept && _url) {
      notifyChunkObserved(_url)
    }

    if (
      !shouldIntercept &&
      _method === "GET" &&
      _url &&
      smoother?.isCriticalStaticAsset?.(_url, _method) &&
      typeof networkFetch === "function"
    ) {
      void networkFetch(_url, { method: "GET", credentials: "include" })
        .then(async (response) => {
          if (!response?.ok) {
            originalSend(body)
            return
          }
          const bytes = await response.arrayBuffer()
          const contentType = response.headers.get("content-type") || "application/octet-stream"
          synthesizeXhrFromBuffer(xhr, response.status, response.statusText, bytes, contentType, {
            "x-aegisstream-cache": "NETWORK"
          })
        })
        .catch(() => originalSend(body))
      return undefined
    }

    // For non-chunk GETs, try cache-first
    if (!shouldIntercept || (_hasRange && !youtubeChunk)) {
      return originalSend(body)
    }

    let cacheLookupUrl = _url

    if (youtubeChunk) {
      cacheLookupUrl = youtubeChunk.cacheKey
    }

    let settled = false
    const CACHE_LOOKUP_TIMEOUT_MS = 300

    const lookupPromise = requestRuntime("CACHE_LOOKUP_REQUEST", {
      url: cacheLookupUrl,
      method: _method,
      hasRange: false
    })

    // Hard timeout: if cache lookup doesn't resolve in time, send the
    // original request so the player is never left hanging.
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      ns.reportRuntimeMetric("cache_lookup_timeout", { transport: "xhr", timeoutMs: CACHE_LOOKUP_TIMEOUT_MS })
      originalSend(body)
    }, CACHE_LOOKUP_TIMEOUT_MS)

    const originalAbort = xhr.abort.bind(xhr)
    xhr.abort = function () {
      if (!settled) {
        settled = true
        clearTimeout(timeoutId)
        ns.reportRuntimeMetric("xhr_abort_during_lookup", { transport: "xhr" })
        // Player called send(), but we held it back.
        // Native abort won't fire events if send() wasn't natively called.
        // We synthesize them to satisfy the player's state machine.
        setTimeout(() => {
          const abortEvent = new Event("abort")
          const loadendEvent = new Event("loadend")
          xhr.dispatchEvent(abortEvent)
          xhr.dispatchEvent(loadendEvent)
        }, 0)
      }
      return originalAbort()
    }

    lookupPromise.then((lookup) => {
      clearTimeout(timeoutId)
      if (settled) return
      const lookupBytes = resolveLookupBytes(lookup)
      if (lookup?.ok && lookup.hit && lookupBytes) {
        settled = true
        // Synthesize a successful XHR response from cache
        const is206 =
          youtubeChunk?.type === "bytes" &&
          Number.isFinite(youtubeChunk.start)
        const statusCode = is206 ? 206 : 200
        
        Object.defineProperty(xhr, "status", { get: () => statusCode, configurable: true })
        Object.defineProperty(xhr, "statusText", { get: () => is206 ? "Partial Content" : "OK", configurable: true })
        Object.defineProperty(xhr, "readyState", { get: () => 4, configurable: true })
        Object.defineProperty(xhr, "response", { get: () => lookupBytes, configurable: true })
        Object.defineProperty(xhr, "responseText", {
          get: () => {
            try { return new TextDecoder().decode(lookupBytes) } catch { return "" }
          },
          configurable: true
        })
        Object.defineProperty(xhr, "getResponseHeader", {
          value: (name) => {
            const lower = name.toLowerCase()
            if (lower === "content-type") return lookup.contentType || "application/octet-stream"
            if (lower === "x-aegisstream-cache") return "HIT"
            if (lower === "content-range" && is206) {
              const actualEnd = Number.isFinite(youtubeChunk.end)
                ? youtubeChunk.end
                : youtubeChunk.start + lookupBytes.byteLength - 1
              return `bytes ${youtubeChunk.start}-${actualEnd}/*`
            }
            return null
          },
          configurable: true,
          writable: true
        })
        Object.defineProperty(xhr, "getAllResponseHeaders", {
          value: () => {
            let headers = `content-type: ${lookup.contentType || "application/octet-stream"}\r\nx-aegisstream-cache: HIT\r\n`
            if (is206) {
              const actualEnd = Number.isFinite(youtubeChunk.end)
                ? youtubeChunk.end
                : youtubeChunk.start + lookupBytes.byteLength - 1
              headers += `content-range: bytes ${youtubeChunk.start}-${actualEnd}/*\r\n`
            }
            return headers
          },
          configurable: true,
          writable: true
        })

        // Dispatch events
        xhr.dispatchEvent(new Event("readystatechange"))
        xhr.dispatchEvent(new Event("load"))
        xhr.dispatchEvent(new Event("loadend"))
        return
      }

      settled = true
      originalSend(body)
    }).catch(() => {
      clearTimeout(timeoutId)
      if (settled) return
      settled = true
      originalSend(body)
    })

    return undefined
  }

  return xhr
}

function installXhrInterceptor() {
  window.XMLHttpRequest = AegisXHR
  window.XMLHttpRequest.prototype = OriginalXHR.prototype
  Object.keys(OriginalXHR).forEach((key) => {
    try {
      window.XMLHttpRequest[key] = OriginalXHR[key]
    } catch {
      // read-only
    }
  })
  window.XMLHttpRequest.UNSENT = 0
  window.XMLHttpRequest.OPENED = 1
  window.XMLHttpRequest.HEADERS_RECEIVED = 2
  window.XMLHttpRequest.LOADING = 3
  window.XMLHttpRequest.DONE = 4
}

ns.installXhrInterceptor = installXhrInterceptor
})()
