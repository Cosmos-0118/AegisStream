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
  isLikelyChunk,
  isPlaylistUrl,
  isPlaylistContentType,
  looksLikePlaylistBody,
  canRelayPlaylist,
  markPlaylistRelayed,
  smoother
} = ns

const networkFetch = fetchWithCircuitBreaker || originalFetch

/** Stay below chrome.runtime.sendMessage structured-clone limits (~64MiB). */
const MAX_XHR_CAPTURE_BYTES = 32 * 1024 * 1024

let syncResponseTapInstalled = false

function isPlaylistRotationGraceActive() {
  const rotated = Number(ns.playlistRotatedAt || 0)
  // Narrow window only — a long grace keeps every belt on 2s timeouts and stalls playback.
  const graceMs = 3_500
  return rotated > 0 && Date.now() - rotated < graceMs
}

function resolveBeltTimeoutMs(lane, { wireInFlight = false, rotationGrace = false } = {}) {
  const collapseMs =
    typeof ns.resolveCollapseWaitTimeoutMs === "function"
      ? ns.resolveCollapseWaitTimeoutMs()
      : 8_000
  if (
    wireInFlight &&
    (lane === "lookup-miss" ||
      lane === "not-candidate-wire-inflight" ||
      lane === "lookup-timeout")
  ) {
    return collapseMs
  }
  switch (lane) {
    case "not-candidate":
    case "not-candidate-wire-inflight":
      return rotationGrace ? 1_400 : 1_200
    case "lookup-miss":
      return rotationGrace ? 1_400 : 1_000
    case "lookup-timeout":
    case "lookup-ipc-fault":
      return rotationGrace ? 1_200 : 1_000
    default:
      return rotationGrace ? 900 : 800
  }
}

function exceedsSafeIpcCaptureSize(byteLength) {
  return Number.isFinite(byteLength) && byteLength > MAX_XHR_CAPTURE_BYTES
}

/** Only payloads authenticated as live CDN fetches may write back to IDB. */
function isAuthorizedForXhrWriteback(xhr) {
  if (xhr.__aegisChunkCaptured === true) return false
  return xhr.__aegisResponseSource === "network-native"
}

function sendAuthorizedNativeNetwork(xhr, body, originalSend) {
  xhr.__aegisResponseSource = "network-native"
  return originalSend(body)
}

function recordXhrWritebackSuppression(xhr, lane = "xhr-sync", reason = "unauthorized") {
  if (xhr.__aegisWritebackSuppressionReported === true) return
  xhr.__aegisWritebackSuppressionReported = true
  if (typeof ns.reportRuntimeMetric === "function") {
    ns.reportRuntimeMetric("xhr_writeback_suppressed", {
      lane,
      reason,
      source: xhr.__aegisResponseSource || "unknown"
    })
  }
}

function resolveXhrResponseSource(responseSource, cacheHeader) {
  if (responseSource) return responseSource
  if (cacheHeader === "COLLAPSED") return "collapse"
  if (cacheHeader === "HIT") return "idb-hit"
  return "idb-hit"
}

function markInternalXhrFulfillment(xhr, responseSource) {
  xhr.__aegisServedFromCache = true
  xhr.__aegisResponseSource = responseSource
  xhr.__aegisChunkCaptured = true
}

function resetXhrCaptureState(xhr) {
  xhr.__aegisChunkCaptured = false
  xhr.__aegisServedFromCache = false
  xhr.__aegisWritebackSuppressionReported = false
  xhr.__aegisResponseSource = "unknown"
}

function bytesFromXhrRawResponse(xhr, rawResponse) {
  if (rawResponse instanceof ArrayBuffer && rawResponse.byteLength > 0) {
    if (exceedsSafeIpcCaptureSize(rawResponse.byteLength)) return null
    const copied =
      typeof copyArrayBufferForBridge === "function"
        ? copyArrayBufferForBridge(rawResponse)
        : rawResponse.slice(0)
    return copied || null
  }
  if (
    xhr.responseType === "arraybuffer" &&
    rawResponse &&
    typeof rawResponse.byteLength === "number" &&
    rawResponse.byteLength > 0 &&
    rawResponse.buffer instanceof ArrayBuffer
  ) {
    if (exceedsSafeIpcCaptureSize(rawResponse.byteLength)) return null
    try {
      const window = rawResponse.buffer.slice(
        rawResponse.byteOffset,
        rawResponse.byteOffset + rawResponse.byteLength
      )
      return typeof copyArrayBufferForBridge === "function"
        ? copyArrayBufferForBridge(window) || window
        : window
    } catch {
      return null
    }
  }
  if (typeof rawResponse === "string" && rawResponse.length > 0) {
    return new TextEncoder().encode(rawResponse).buffer
  }
  return null
}

let lastXhrInvalidatedWarnAt = 0

function captureXhrResponseSync(xhr, rawResponse) {
  if (ns.extensionEnabled === false || ns.serveFromCache === false) return
  // Only capture fully finalized responses; readyState 3 (LOADING) may be truncated.
  if (xhr.readyState !== OriginalXHR.DONE) return

  const status = xhr.status
  if (status < 200 || status >= 300) return

  const url = xhr.__aegisUrl || (xhr.responseURL ? stripHash(xhr.responseURL) : null)
  const method = (xhr.__aegisMethod || "GET").toUpperCase()
  if (!url || method !== "GET") return
  if (url && globalThis.AegisSitePolicy?.shouldPassthroughPlayerRequest?.(url)) return

  const shouldIntercept = isLikelyChunk(url)
  if (!shouldIntercept) return
  if (status !== 200) return

  const bytes = bytesFromXhrRawResponse(xhr, rawResponse)
  if (!bytes) {
    if (
      rawResponse instanceof ArrayBuffer &&
      exceedsSafeIpcCaptureSize(rawResponse.byteLength)
    ) {
      xhr.__aegisChunkCaptured = true
      logBridge(
        `XHR sync capture dropped rogue buffer (${rawResponse.byteLength} bytes exceeds safe IPC limits)`,
        "WARN"
      )
    }
    return
  }

  const responseSource = xhr.__aegisResponseSource || "unknown"
  const byteLength = bytes.byteLength
  if (!isAuthorizedForXhrWriteback(xhr)) {
    // Distinguish "already captured this XHR" (player re-reads xhr.response, expected)
    // from a real authorization denial (cached/collapsed source attempting writeback).
    const alreadyCaptured = xhr.__aegisChunkCaptured === true
    const suppressionReason = alreadyCaptured ? "duplicate-read" : "unauthorized-source"
    recordXhrWritebackSuppression(xhr, "xhr-sync", suppressionReason)
    if (typeof logBridge === "function" && !alreadyCaptured) {
      // Only log the first denial — duplicate-read suppressions are noise that
      // contradict the COMMITTED log for the same XHR and confuse diagnostics.
      logBridge(
        `[WRITEBACK-SUPPRESSED] source=${responseSource} bytes=${byteLength} reason=${suppressionReason} url=${xhr.__aegisUrl || url || "unknown"}`,
        "DEBUG"
      )
    }
    return
  }

  xhr.__aegisChunkCaptured = true

  const cacheLookupUrl = url
  if (typeof ns.noteStoreIntent === "function") {
    ns.noteStoreIntent(cacheLookupUrl)
  }
  const ct = xhr.getResponseHeader("content-type") || ""
  if (typeof logBridge === "function") {
    logBridge(
      `[WRITEBACK-COMMITTED] source=${responseSource} bytes=${byteLength} url=${xhr.__aegisUrl || cacheLookupUrl || url || "unknown"}`,
      "INFO"
    )
  }
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
      if (
        typeof ns.isExtensionContextInvalidated === "function" &&
        ns.isExtensionContextInvalidated(storeRes)
      ) {
        const now = Date.now()
        if (now - lastXhrInvalidatedWarnAt < 3_000) return
        lastXhrInvalidatedWarnAt = now
        logBridge(
          `XHR sync store deferred until extension reconnects: ${String(cacheLookupUrl).slice(-80)}`,
          "DEBUG"
        )
        return
      }
      logBridge(
        `XHR sync capture store failed (${formatStoreChunkError(storeRes)}): ${String(cacheLookupUrl).slice(-80)}`,
        "WARN"
      )
    })
    .catch((error) => {
      if (document.visibilityState !== "visible") return
      const synthetic = { ok: false, error: error?.message || String(error) }
      if (
        typeof ns.isExtensionContextInvalidated === "function" &&
        ns.isExtensionContextInvalidated(synthetic, error)
      ) {
        return
      }
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

function applyXhrCachedPayload(
  xhr,
  lookupBytes,
  lookup,
  cacheHeader = "HIT",
  responseSource = null,
  cacheLookupUrl = null
) {
  markInternalXhrFulfillment(xhr, resolveXhrResponseSource(responseSource, cacheHeader))
  if (cacheHeader === "HIT" && typeof ns.noteLocalCacheKey === "function") {
    const key = cacheLookupUrl || xhr.__aegisUrl
    if (key) ns.noteLocalCacheKey(key)
  }
  Object.defineProperty(xhr, "status", { get: () => 200, configurable: true })
  Object.defineProperty(xhr, "statusText", {
    get: () => "OK",
    configurable: true
  })
  Object.defineProperty(xhr, "readyState", { get: () => 4, configurable: true })
  Object.defineProperty(xhr, "response", { get: () => lookupBytes, configurable: true })
  Object.defineProperty(xhr, "responseText", {
    get: () => {
      try {
        return new TextDecoder().decode(lookupBytes)
      } catch {
        return ""
      }
    },
    configurable: true
  })
  const instantHdr =
    globalThis.AegisCacheResponseHeaders?.buildInstantCacheHeaderRecord?.(
      lookup?.contentType || "application/octet-stream"
    ) || {}
  Object.defineProperty(xhr, "getResponseHeader", {
    value: (name) => {
      const lower = name.toLowerCase()
      if (lower === "content-type") return lookup?.contentType || "application/octet-stream"
      if (instantHdr[lower] != null) return instantHdr[lower]
      if (lower === "x-aegisstream-cache") return cacheHeader
      return null
    },
    configurable: true,
    writable: true
  })
  Object.defineProperty(xhr, "getAllResponseHeaders", {
    value: () => {
      return `content-type: ${lookup?.contentType || "application/octet-stream"}\r\nx-aegisstream-cache: ${cacheHeader}\r\n`
    },
    configurable: true,
    writable: true
  })
  xhr.dispatchEvent(new Event("readystatechange"))
  xhr.dispatchEvent(new Event("load"))
  xhr.dispatchEvent(new Event("loadend"))
}

async function tryCollapseXhrOntoInflightPrefetch(_url, cacheLookupUrl) {
  // Promote a queued-but-not-started prefetch into an active page wire so the
  // player joins one shared future instead of racing it to the network.
  const demandStarted =
    typeof ns.demandStartQueuedPrefetch === "function" &&
    ns.demandStartQueuedPrefetch(_url, cacheLookupUrl)

  const pageInflight =
    demandStarted ||
    (typeof ns.hasActivePageWire === "function"
      ? ns.hasActivePageWire(_url, cacheLookupUrl)
      : typeof ns.isNetworkFetchInflight === "function" &&
        ns.isNetworkFetchInflight(_url, cacheLookupUrl))

  if (pageInflight && typeof ns.joinActivePageWire === "function") {
    logBridge(
      `Request collapse (XHR local wire): ${String(cacheLookupUrl || _url).slice(-48)}`,
      "DEBUG"
    )
    ns.reportRuntimeMetric("request_collapse_attempt", { transport: "xhr", lane: "page-wire" })
    const localWire = await ns.joinActivePageWire(_url, cacheLookupUrl)
    if (localWire?.ok && localWire.bytes) {
      return localWire
    }
    if (localWire?.aborted || localWire?.cancelled) {
      ns.reportRuntimeMetric("collapse_cancellation", {
        transport: "xhr",
        cacheKey:
          typeof ns.resolvePageRegistryKey === "function"
            ? ns.resolvePageRegistryKey(_url, cacheLookupUrl)
            : cacheLookupUrl
      })
    } else if (localWire && !localWire.ok) {
      ns.reportRuntimeMetric("collapse_fallback", {
        transport: "xhr",
        reason: localWire.reason || "local-wire-miss"
      })
    }
  }

  if (typeof ns.awaitCollapsedNetworkDelivery !== "function") return null

  let backgroundInflight = false
  try {
    const query = await requestRuntime("INFLIGHT_PREFETCH_QUERY", {
      url: cacheLookupUrl || _url
    })
    backgroundInflight = query?.inflight === true
  } catch {
    backgroundInflight = false
  }
  if (!pageInflight && !backgroundInflight) return null

  logBridge(
    `Request collapse (XHR background): awaiting in-flight prefetch for ${String(cacheLookupUrl || _url).slice(-48)}`,
    "DEBUG"
  )
  ns.reportRuntimeMetric("request_collapse_attempt", { transport: "xhr", lane: "background" })

  return ns.awaitCollapsedNetworkDelivery(
    _url,
    cacheLookupUrl,
    async () => {
      const lookup = await requestRuntime("CACHE_LOOKUP_REQUEST", {
        url: cacheLookupUrl,
        method: "GET",
        hasRange: false
      })
      const lookupBytes = resolveLookupBytes(lookup)
      if (lookup?.ok && lookup.hit && lookupBytes) {
        return {
          ok: true,
          bytes: lookupBytes,
          contentType: lookup.contentType,
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
}

function synthesizeXhrFromBuffer(xhr, statusCode, statusText, bytes, contentType, extraHeaders = {}) {
  xhr.__aegisServedFromCache = true
  xhr.__aegisResponseSource = "memory-hit"
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

    // Always attach a load listener to capture playlist responses from XHR
    xhr.addEventListener("load", function xhrLoadHandler() {
      try {
        if (xhr.status >= 200 && xhr.status < 300 && _url) {
          const ct = xhr.getResponseHeader("content-type") || ""

          // Check for playlist content
          let isPlaylist = isPlaylistUrl(_url) || isPlaylistContentType(ct)
          let text = null
          if (typeof xhr.responseText === "string") {
            text = xhr.responseText
          } else if (xhr.response && typeof xhr.response === "string") {
            text = xhr.response
          }
          if (!isPlaylist && text && _url && _url.startsWith("blob:")) {
            if (looksLikePlaylistBody(text)) isPlaylist = true
          }
          if (isPlaylist) {
            if (text && (isPlaylistUrl(_url) || looksLikePlaylistBody(text))) {
              if (canRelayPlaylist(_url)) {
                markPlaylistRelayed(_url)
                if (ns.extensionEnabled !== false) {
                  notifyRuntime("PLAYLIST_CONTENT", { url: _url, text })
                }
              }
            }
          }

          const shouldIntercept =
            _method === "GET" && _url && isLikelyChunk(_url)

          if (shouldIntercept && xhr.status === 200) {
            let byteLength = 0
            if (xhr.response instanceof ArrayBuffer) {
              byteLength = xhr.response.byteLength
            } else if (typeof xhr.response === "string") {
              byteLength = new TextEncoder().encode(xhr.response).byteLength
            }
            if (byteLength > 0 && !exceedsSafeIpcCaptureSize(byteLength)) {
              const cacheLookupUrl = _url

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
                if (exceedsSafeIpcCaptureSize(bytesForStore.byteLength)) {
                  logBridge(
                    `XHR load capture dropped rogue buffer (${bytesForStore.byteLength} bytes exceeds safe IPC limits)`,
                    "WARN"
                  )
                  return
                }
                if (!isAuthorizedForXhrWriteback(xhr)) {
                  recordXhrWritebackSuppression(xhr, "xhr-load")
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
      isLikelyChunk(_url) &&
      !isPlaylistUrl(_url)
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
            sendAuthorizedNativeNetwork(xhr, body, originalSend)
            return
          }
          const bytes = await response.arrayBuffer()
          const contentType = response.headers.get("content-type") || "application/octet-stream"
          synthesizeXhrFromBuffer(xhr, response.status, response.statusText, bytes, contentType, {
            "x-aegisstream-cache": "NETWORK"
          })
        })
        .catch(() => sendAuthorizedNativeNetwork(xhr, body, originalSend))
      return undefined
    }

    // For non-chunk GETs, try cache-first
    if (!shouldIntercept) {
      return originalSend(body)
    }

    const cacheLookupUrl = _url

    // L1 hot path: serve from page heap before any IPC / collapse ladder.
    if (
      ns.extensionEnabled !== false &&
      ns.serveFromCache !== false &&
      typeof ns.getHotBytes === "function"
    ) {
      let hot = null
      try {
        hot = ns.getHotBytes(cacheLookupUrl)
      } catch {
        hot = null
      }
      if (hot?.ok && hot.bytes && hot.bytes.byteLength > 0) {
        ns.reportRuntimeMetric("page_cache_telemetry", { metric: "hotHits", amount: 1 })
        ns.reportRuntimeMetric("page_cache_telemetry", { metric: "cacheHits", amount: 1 })
        ns.reportRuntimeMetric("page_cache_telemetry", { metric: "cacheLookups", amount: 1 })
        ns.reportRuntimeMetric("page_cache_telemetry", { metric: "cacheServes", amount: 1 })
        applyXhrCachedPayload(
          xhr,
          hot.bytes,
          { contentType: hot.contentType },
          "HIT",
          "hot-l1",
          cacheLookupUrl
        )
        return undefined
      }
    }

    const wireInFlight =
      typeof ns.isKeyInFlight === "function" && ns.isKeyInFlight(cacheLookupUrl)
    const cacheCandidate =
      typeof ns.isLikelyCacheHitCandidate !== "function" ||
      ns.isLikelyCacheHitCandidate(cacheLookupUrl)

    const deliverCollapsedXhr = (collapsed, viaIntent = false) => {
      if (!collapsed?.ok || !collapsed.bytes) return false
      const savedBytes =
        collapsed.bytes && typeof collapsed.bytes.byteLength === "number"
          ? collapsed.bytes.byteLength
          : 0
      const responseSource =
        collapsed.via === "hot-l1"
          ? "hot-l1"
          : collapsed.fromCache === true
            ? "idb-hit"
            : "collapse"
      ns.reportRuntimeMetric("request_collapse_hit", {
        transport: "xhr",
        fromCache: collapsed.fromCache === true,
        savedBytes,
        viaIntent: viaIntent === true
      })
      if (collapsed.bytes && typeof ns.putHotBytes === "function") {
        ns.putHotBytes(cacheLookupUrl, collapsed.bytes, {
          contentType: collapsed.contentType || "application/octet-stream",
          status: 200
        })
      }
      applyXhrCachedPayload(
        xhr,
        collapsed.bytes,
        collapsed,
        collapsed.fromCache ? "HIT" : "COLLAPSED",
        responseSource,
        cacheLookupUrl
      )
      return true
    }

    const runCollapseIntercept = async (viaIntent = false) => {
      try {
        const collapsed = await tryCollapseXhrOntoInflightPrefetch(
          _url,
          cacheLookupUrl
        )
        if (deliverCollapsedXhr(collapsed, viaIntent)) return true
      } catch (error) {
        ns.reportRuntimeMetric("collapse_intercept_fault", {
          transport: "xhr",
          error: error?.message || String(error || "unknown")
        })
      }
      return false
    }

    /**
     * Final safety belt before burning CDN bandwidth.
     *
     * The page-side registry (`isLikelyCacheHitCandidate`) is best-effort: it can
     * be stale, not-yet-synced from background, or `resolveCanonicalCoalesceKey`
     * may have returned null for an obfuscated host. When that registry is wrong,
     * the older code went straight to native fetch and re-stored an IDB hit as
     * `xhr-sync` — the exact leak observed in the trace:
     *   Cache HIT (background, bytes=N)
     *     -> WRITEBACK-COMMITTED source=network-native bytes=N (page)
     *     -> StoreChunk accepted: source=xhr-sync bytes=N
     *
     * Always do one bounded IDB lookup before falling through to native fetch.
     * This is a small IPC vs. a multi-MB CDN GET — always worth it.
     */
    const tryIdbBeltBeforeNative = async (beltLane, beltTimeoutMs = 800) => {
      try {
        const beltLookup = await Promise.race([
          requestRuntime("CACHE_LOOKUP_REQUEST", {
            url: cacheLookupUrl,
            method: _method,
            hasRange: false
          }),
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: false, hit: false, timeout: true }), beltTimeoutMs)
          )
        ])
        if (beltLookup?.timeout) {
          ns.reportRuntimeMetric("xhr_idb_belt_timeout", {
            lane: beltLane,
            url: cacheLookupUrl
          })
          return false
        }
        const beltBytes = resolveLookupBytes(beltLookup)
        if (beltLookup?.ok && beltLookup.hit && beltBytes) {
          if (
            beltLane.startsWith("not-candidate") &&
            typeof ns.noteRegistryFalseNegative === "function"
          ) {
            // Registry said absent but IDB had the bytes — decay registry trust.
            ns.noteRegistryFalseNegative()
          }
          if (typeof ns.putHotBytes === "function") {
            ns.putHotBytes(cacheLookupUrl, beltBytes, {
              contentType: beltLookup.contentType || "application/octet-stream",
              status: 200
            })
          }
          ns.reportRuntimeMetric("xhr_idb_belt_hit", {
            lane: beltLane,
            bytes: beltBytes.byteLength
          })
          applyXhrCachedPayload(xhr, beltBytes, beltLookup, "HIT", "idb-hit", cacheLookupUrl)
          return true
        }
        ns.reportRuntimeMetric("xhr_idb_belt_miss", {
          lane: beltLane,
          url: cacheLookupUrl
        })
      } catch (error) {
        ns.reportRuntimeMetric("xhr_idb_belt_fault", {
          lane: beltLane,
          error: error?.message || String(error || "unknown")
        })
      }
      return false
    }

    const fallbackToNativeWithBelt = async (beltLane) => {
      const rotationGrace = isPlaylistRotationGraceActive()
      const hadInflightIntent =
        typeof ns.isInflightKey === "function" && ns.isInflightKey(cacheLookupUrl)
      if (typeof ns.awaitInflightChunkStoreByUrl === "function") {
        await ns.awaitInflightChunkStoreByUrl(cacheLookupUrl)
      }
      if (rotationGrace || hadInflightIntent) {
        if (await runCollapseIntercept(true)) return
      }
      const beltTimeoutMs = resolveBeltTimeoutMs(beltLane, { wireInFlight, rotationGrace })
      if (await tryIdbBeltBeforeNative(beltLane, beltTimeoutMs)) return
      const retryBelt = async (lane, delayMs) => {
        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
        return tryIdbBeltBeforeNative(lane, beltTimeoutMs)
      }
      if (
        hadInflightIntent ||
        (typeof ns.isInflightKey === "function" && ns.isInflightKey(cacheLookupUrl))
      ) {
        if (await retryBelt(`${beltLane}-retry`, 90)) return
        if (await retryBelt(`${beltLane}-retry2`, 180)) return
      } else if (
        typeof ns.isSwiftStreamTransportSegment === "function" &&
        ns.isSwiftStreamTransportSegment(cacheLookupUrl)
      ) {
        if (await retryBelt(`${beltLane}-segment-retry`, rotationGrace ? 180 : 120)) return
      }
      if (await runCollapseIntercept(false)) return
      sendAuthorizedNativeNetwork(xhr, body, originalSend)
    }

    if (!cacheCandidate) {
      ns.reportRuntimeMetric("cache_lookup_registry_miss", { transport: "xhr" })
    }

    // Future-first lane: when this segment already has an active page wire
    // (or a queued prefetch we can demand-start), join that future directly —
    // zero IPC — and only fall back to the lookup/belt ladder if it fails.
    const pageWireJoinable =
      (typeof ns.hasActivePageWire === "function" &&
        ns.hasActivePageWire(_url, cacheLookupUrl)) ||
      (typeof ns.demandStartQueuedPrefetch === "function" &&
        ns.demandStartQueuedPrefetch(_url, cacheLookupUrl))
    if (pageWireJoinable && !ns.isCachedKey?.(cacheLookupUrl)) {
      let wireJoinAborted = false
      const originalWireAbort = xhr.abort.bind(xhr)
      xhr.abort = function () {
        wireJoinAborted = true
        ns.reportRuntimeMetric("xhr_abort_during_lookup", { transport: "xhr", lane: "wire-join" })
        setTimeout(() => {
          xhr.dispatchEvent(new Event("abort"))
          xhr.dispatchEvent(new Event("loadend"))
        }, 0)
        return originalWireAbort()
      }
      void (async () => {
        const delivered = wireJoinAborted ? true : await runCollapseIntercept(true)
        if (wireJoinAborted) return
        if (!delivered) {
          await fallbackToNativeWithBelt("wire-join-miss")
        }
      })()
      return undefined
    }

    let settled = false
    const CACHE_LOOKUP_TIMEOUT_MS =
      wireInFlight && typeof ns.resolveCollapseWaitTimeoutMs === "function"
        ? ns.resolveCollapseWaitTimeoutMs()
        : wireInFlight
          ? 8_000
          : 2_000

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
      void (async () => {
        const delivered = await runCollapseIntercept(false)
        if (!delivered) {
          await fallbackToNativeWithBelt("lookup-timeout")
        }
      })()
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
        if (typeof ns.putHotBytes === "function") {
          ns.putHotBytes(cacheLookupUrl, lookupBytes, {
            contentType: lookup.contentType || "application/octet-stream",
            status: 200
          })
        }
        ns.reportRuntimeMetric("cache_lookup_page_delivered", {
          transport: "xhr",
          byteLength: lookupBytes.byteLength,
          viaBase64: !lookup.bytes && typeof lookup.bytesBase64 === "string"
        })
        applyXhrCachedPayload(xhr, lookupBytes, lookup, "HIT", "idb-hit", cacheLookupUrl)
        return
      }

      settled = true
      // Miss can still race with a just-finished store; collapse before belt/native.
      void (async () => {
        const rotationGrace = isPlaylistRotationGraceActive()
        if (
          typeof ns.demandStartQueuedPrefetch === "function" &&
          ns.demandStartQueuedPrefetch(_url, cacheLookupUrl)
        ) {
          if (await runCollapseIntercept(true)) return
        }
        if (rotationGrace || wireInFlight) {
          if (typeof ns.awaitInflightChunkStoreByUrl === "function") {
            await ns.awaitInflightChunkStoreByUrl(cacheLookupUrl)
          }
          if (await runCollapseIntercept(true)) return
        }
        const delivered = await runCollapseIntercept(false)
        if (!delivered) await fallbackToNativeWithBelt("lookup-miss")
      })()
    }).catch(() => {
      clearTimeout(timeoutId)
      if (settled) return
      settled = true
      // Lookup IPC rejected (not a clean MISS) — IDB may still have the bytes.
      void fallbackToNativeWithBelt("lookup-ipc-fault")
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
