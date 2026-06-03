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
  storeChunkFromPage,
  copyArrayBufferForBridge,
  formatStoreChunkError,
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

let syncResponseTapInstalled = false

function resetXhrCaptureState(xhr) {
  xhr.__aegisChunkCaptured = false
  xhr.__aegisServedFromCache = false
}

function bytesFromXhrRawResponse(xhr, rawResponse) {
  if (rawResponse instanceof ArrayBuffer && rawResponse.byteLength > 0) {
    return rawResponse.slice(0)
  }
  if (
    xhr.responseType === "arraybuffer" &&
    rawResponse &&
    typeof rawResponse.byteLength === "number" &&
    rawResponse.byteLength > 0 &&
    rawResponse.buffer instanceof ArrayBuffer
  ) {
    try {
      return rawResponse.buffer.slice(
        rawResponse.byteOffset,
        rawResponse.byteOffset + rawResponse.byteLength
      )
    } catch {
      return null
    }
  }
  if (typeof rawResponse === "string" && rawResponse.length > 0) {
    return new TextEncoder().encode(rawResponse).buffer
  }
  return null
}

function resolveXhrYoutubeChunk(xhr, url, status) {
  if (!isYoutubeVideoPlaybackUrl(url)) return null
  const requestRangeHeaders = new Headers()
  if (xhr.__aegisRangeHeader) {
    requestRangeHeaders.set("Range", xhr.__aegisRangeHeader)
  }
  let youtubeChunk = buildYoutubeChunkState(url, requestRangeHeaders)
  if (!youtubeChunk && status === 206) {
    youtubeChunk = buildYoutubeChunkStateFromContentRange(
      url,
      xhr.getResponseHeader("content-range")
    )
  }
  return youtubeChunk
}

function captureXhrResponseSync(xhr, rawResponse) {
  if (xhr.__aegisServedFromCache === true) return
  if (xhr.__aegisChunkCaptured === true) return
  if (ns.extensionEnabled === false || ns.serveFromCache === false) return
  // Only capture fully finalized responses; readyState 3 (LOADING) may be truncated.
  if (xhr.readyState !== OriginalXHR.DONE) return

  const status = xhr.status
  if (status < 200 || status >= 300) return

  const url = xhr.__aegisUrl || (xhr.responseURL ? stripHash(xhr.responseURL) : null)
  const method = (xhr.__aegisMethod || "GET").toUpperCase()
  if (!url || method !== "GET") return
  if (url && globalThis.AegisSitePolicy?.shouldPassthroughPlayerRequest?.(url)) return

  const youtubeChunk = resolveXhrYoutubeChunk(xhr, url, status)
  const shouldIntercept = isLikelyChunk(url) || Boolean(youtubeChunk)
  if (!shouldIntercept) return
  if (!(status === 200 || (status === 206 && youtubeChunk?.type === "bytes"))) return

  const bytes = bytesFromXhrRawResponse(xhr, rawResponse)
  if (!bytes) return

  xhr.__aegisChunkCaptured = true

  let cacheLookupUrl = url
  if (youtubeChunk) {
    cacheLookupUrl = youtubeChunk.cacheKey
  }

  const ct = xhr.getResponseHeader("content-type") || ""
  void storeChunkFromPage({
    url: cacheLookupUrl,
    contentType: ct,
    bytes,
    status: 200,
    method,
    hasRange: false,
    captureSource: "xhr-sync"
  })
    .then((storeRes) => {
      if (storeRes?.ok || document.visibilityState !== "visible") return
      logBridge(
        `XHR sync capture store failed (${formatStoreChunkError(storeRes)}): ${String(cacheLookupUrl).slice(-80)}`,
        "WARN"
      )
    })
    .catch((error) => {
      if (document.visibilityState !== "visible") return
      logBridge(
        `XHR sync capture store failed (${formatStoreChunkError(null, error)}): ${String(cacheLookupUrl).slice(-80)}`,
        "WARN"
      )
    })
}

function installSyncXhrResponseTap() {
  if (syncResponseTapInstalled) return
  const responseDesc = Object.getOwnPropertyDescriptor(OriginalXHR.prototype, "response")
  const originalResponseGet = responseDesc?.get
  if (typeof originalResponseGet !== "function") return

  Object.defineProperty(OriginalXHR.prototype, "response", {
    get: function aegisXhrResponseGet() {
      const rawResponse = originalResponseGet.call(this)
      try {
        captureXhrResponseSync(this, rawResponse)
      } catch {
        // Never break player reads
      }
      return rawResponse
    },
    configurable: true,
    enumerable: true
  })
  syncResponseTapInstalled = true
}

function synthesizeXhrFromBuffer(xhr, statusCode, statusText, bytes, contentType, extraHeaders = {}) {
  xhr.__aegisServedFromCache = true
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
    resetXhrCaptureState(xhr)
    _method = (method || "GET").toUpperCase()
    try {
      _url = stripHash(new URL(url, location.href).toString())
    } catch {
      _url = stripHash(url)
    }
    xhr.__aegisMethod = _method
    xhr.__aegisUrl = _url
    return originalOpen(method, url, ...args)
  }

  const originalSetRequestHeader = xhr.setRequestHeader.bind(xhr)
  xhr.setRequestHeader = function (name, value) {
    if (name.toLowerCase() === "range") {
      _hasRange = true
      _rangeHeaderValue = value
      xhr.__aegisRangeHeader = value
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
      globalThis.AegisYoutubeCrossItag?.recordTemplate?.(_url)
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
        if (xhr.__aegisServedFromCache === true) {
          return
        }
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
            let byteLength = 0
            if (xhr.response instanceof ArrayBuffer) {
              byteLength = xhr.response.byteLength
            } else if (typeof xhr.response === "string") {
              byteLength = new TextEncoder().encode(xhr.response).byteLength
            }
            if (byteLength > 0) {
              let cacheLookupUrl = _url

              if (responseYoutubeChunk) {
                cacheLookupUrl = responseYoutubeChunk.cacheKey
                const prefetchHeaders = buildYouTubePrefetchHeaders(
                  requestRangeHeaders,
                  responseYoutubeChunk,
                  byteLength
                )
                window.AegisRangeBuffer.triggerHeuristicPrefetch(
                  _url,
                  prefetchHeaders,
                  notifyRuntime,
                  requestRuntime
                )
                globalThis.AegisYoutubeCrossItag?.maybeSpeculateFromPlayback?.(
                  _url,
                  responseYoutubeChunk
                )
              }

              if (xhr.__aegisChunkCaptured === true) {
                return
              }

              if (ns.extensionEnabled !== false && ns.serveFromCache !== false) {
                let bytes = null
                if (xhr.response instanceof ArrayBuffer) {
                  bytes = xhr.response
                } else if (typeof xhr.response === "string") {
                  bytes = new TextEncoder().encode(xhr.response).buffer
                }
                const bytesForStore =
                  typeof copyArrayBufferForBridge === "function"
                    ? copyArrayBufferForBridge(bytes)
                    : null
                if (!bytesForStore) {
                  return
                }
                void storeChunkFromPage({
                  url: cacheLookupUrl,
                  contentType: ct,
                  bytes: bytesForStore,
                  status: 200,
                  method: _method,
                  hasRange: false,
                  captureSource: "xhr-load"
                }).then((storeRes) => {
                  if (storeRes?.ok || document.visibilityState !== "visible") return
                  logBridge(
                    `XHR chunk store failed (${formatStoreChunkError(storeRes)}): ${String(cacheLookupUrl).slice(-80)}`,
                    "WARN"
                  )
                }).catch((error) => {
                  if (document.visibilityState !== "visible") return
                  logBridge(
                    `XHR chunk store failed (${formatStoreChunkError(null, error)}): ${String(cacheLookupUrl).slice(-80)}`,
                    "WARN"
                  )
                })
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

    if (
      typeof ns.isLikelyCacheHitCandidate === "function" &&
      !ns.isLikelyCacheHitCandidate(cacheLookupUrl)
    ) {
      originalSend(body)
      return
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
        xhr.__aegisServedFromCache = true
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
        const instantHdr =
          globalThis.AegisCacheResponseHeaders?.buildInstantCacheHeaderRecord?.(
            lookup.contentType || "application/octet-stream"
          ) || {}
        Object.defineProperty(xhr, "getResponseHeader", {
          value: (name) => {
            const lower = name.toLowerCase()
            if (lower === "content-type") return lookup.contentType || "application/octet-stream"
            if (instantHdr[lower] != null) return instantHdr[lower]
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
  installSyncXhrResponseTap()
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
