(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("hls-media")) {
  return
}

const {
  requestRuntime,
  storeChunkFromPage,
  formatStoreChunkError,
  notifyRuntime,
  logBridge,
  knownSegments,
  canRelayPlaylist,
  markPlaylistRelayed,
  clearPlaylistRelayDedup,
  originalFetch
} = ns

async function bodyToArrayBuffer(body) {
  if (body == null) return null
  if (typeof body === "string") {
    return new TextEncoder().encode(body).buffer
  }
  if (body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString()).buffer
  }
  if (body instanceof Blob) {
    return await body.arrayBuffer()
  }
  if (body instanceof ArrayBuffer) {
    return body
  }
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  }
  return null
}

function cloneResponseForPlayer(response, stream) {
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  })
}

async function readStreamToArrayBuffer(stream, maxBytes = 64 * 1024 * 1024) {
  const reader = stream.getReader()
  const chunks = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    total += value.byteLength
    if (total > maxBytes) {
      return { bytes: null, truncated: true, byteLength: total }
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged.buffer, truncated: false, byteLength: total }
}

function cacheNetworkStreamInBackground({
  stream,
  cacheLookupUrl,
  contentType,
  storeMethod,
  urlForLog
}) {
  void (async () => {
    const streamed = await readStreamToArrayBuffer(stream)
    if (!streamed.bytes) {
      if (streamed.truncated) {
        logBridge(
          `Skipped caching oversized response (~${Math.round((streamed.byteLength || 0) / 1024)} KB): ${String(urlForLog).slice(-80)}`,
          "DEBUG"
        )
      }
      return
    }

    const bytesForStore =
      typeof ns.copyArrayBufferForBridge === "function"
        ? ns.copyArrayBufferForBridge(streamed.bytes)
        : streamed.bytes
    if (!bytesForStore) {
      logBridge(
        `Network chunk store failed (detached-buffer): ${String(urlForLog).slice(-80)}`,
        "WARN"
      )
      return
    }

    const storeRes = await storeChunkFromPage({
      url: cacheLookupUrl,
      contentType,
      bytes: bytesForStore,
      status: 200,
      method: storeMethod,
      hasRange: false,
      captureSource: "fetch-tee"
    }).catch((error) => ({ ok: false, error: formatStoreChunkError(null, error) }))

    if (streamed.bytes && typeof ns.putHotBytes === "function") {
      ns.putHotBytes(cacheLookupUrl, streamed.bytes, {
        contentType,
        status: 200
      })
    }

    if (!storeRes?.ok) {
      logBridge(
        `Network chunk store failed (${formatStoreChunkError(storeRes)}): ${String(urlForLog).slice(-80)}`,
        "WARN"
      )
    }
  })().catch((error) => {
    const message = error?.message || "unknown"
    const level = /aborted/i.test(message) ? "DEBUG" : "WARN"
    logBridge(`Background stream cache failed: ${message}`, level)
  })
}

/** SwiftStream wraps segments in a stable transport path; playlist tokens omit it. */
function isSwiftStreamTransportSegment(url) {
  return typeof url === "string" && /\/EV9fQAQQ/i.test(url)
}

function isSwiftStreamPlaylistProxy(url) {
  if (typeof url !== "string") return false
  if (!/\/proxy\/oppai\/(kite|dio)\//i.test(url)) return false
  return !isSwiftStreamTransportSegment(url)
}

function isLikelyChunk(url) {
  if (!url) return false

  if (globalThis.AegisSitePolicy?.shouldPassthroughPlayerRequest?.()) return false
  if (globalThis.AegisSitePolicy?.isTwitchMediaUrl?.(url)) return true
  if (isSwiftStreamPlaylistProxy(url)) return false
  if (isSwiftStreamTransportSegment(url)) return true

  const base = url.split("?")[0]
  if (knownSegments.has(base)) return true

  if (typeof ns.buildMediaInvariantKey === "function") {
    const invariant = ns.buildMediaInvariantKey(url)
    if (invariant && invariant.startsWith("aegis|")) return true
  }

  if (/\.(ts|m4s|mp4|cmf|webm|aac|m4a|m4v|fmp4)($|\?)/i.test(url)) return true
  if (/\b(segment|frag|chunk|Fragments)\b/i.test(url)) return true
  if (/akamaihd\.net\b.*\b(media|seg)\b/i.test(url)) return true
  if (/\bttvnw\.net\b/i.test(url)) return true
  if (/\bjtvnw\.net\b/i.test(url)) return true
  return false
}

function isPlaylistUrl(url) {
  if (!url) return false
  if (isSwiftStreamPlaylistProxy(url)) return true
  if (/\.m3u8($|\?)/i.test(url)) return true
  if (/\.mpd($|\?)/i.test(url)) return true
  if (/\/manifest\b/i.test(url) && /format=m3u8|hls|dash/i.test(url)) return true
  return false
}

function isPlaylistContentType(ct) {
  if (!ct) return false
  ct = ct.toLowerCase()
  return (
    ct.includes("mpegurl") ||
    ct.includes("x-mpegurl") ||
    ct.includes("dash+xml") ||
    ct.includes("vnd.apple.mpegurl")
  )
}

function looksLikePlaylistBody(text) {
  if (!text || text.length < 10) return false
  const trimmed = text.trimStart()
  if (trimmed.startsWith("#EXTM3U")) return true
  if (trimmed.startsWith("<?xml") && /<MPD\b/i.test(text)) return true
  return false
}

function maybeCapturePlaylist(url, contentType, responseClone) {
  if (!url) return
  if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return
  if (!canRelayPlaylist(url)) return

  const isUrlMatch = isPlaylistUrl(url)
  const isCtMatch = isPlaylistContentType(contentType)
  const isBlob = url && url.startsWith("blob:")

  if (!isUrlMatch && !isCtMatch && !isBlob) return

  markPlaylistRelayed(url)

  responseClone.text().then((text) => {
    if (!text || text.length < 10) return
    if (!isUrlMatch && !looksLikePlaylistBody(text)) return

    notifyRuntime("PLAYLIST_CONTENT", { url, text })
  }).catch(() => {})
}

async function refreshPlaylistFromPage(url, generation) {
  if (!url || globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return false
  clearPlaylistRelayDedup(url)
  try {
    let res = await originalFetch(url, { credentials: "include", cache: "no-store" })
    if (res.status === 403 || res.status === 401) {
      res = await originalFetch(url, { cache: "no-store" })
    }
    if (!res.ok) {
      notifyRuntime("PLAYLIST_REFRESH_FAILED", { url, generation, status: res.status })
      return false
    }
    const text = await res.text()
    if (!text || !looksLikePlaylistBody(text)) {
      notifyRuntime("PLAYLIST_REFRESH_FAILED", { url, generation, status: 0 })
      return false
    }
    markPlaylistRelayed(url)
    notifyRuntime("PLAYLIST_CONTENT", { url, text, generation })
    return true
  } catch {
    notifyRuntime("PLAYLIST_REFRESH_FAILED", { url, generation, status: 0 })
    return false
  }
}

ns.bodyToArrayBuffer = bodyToArrayBuffer
ns.cloneResponseForPlayer = cloneResponseForPlayer
ns.cacheNetworkStreamInBackground = cacheNetworkStreamInBackground
ns.isLikelyChunk = isLikelyChunk
ns.isPlaylistUrl = isPlaylistUrl
ns.isSwiftStreamTransportSegment = isSwiftStreamTransportSegment
ns.isSwiftStreamPlaylistProxy = isSwiftStreamPlaylistProxy
ns.isPlaylistContentType = isPlaylistContentType
ns.looksLikePlaylistBody = looksLikePlaylistBody
ns.maybeCapturePlaylist = maybeCapturePlaylist
ns.refreshPlaylistFromPage = refreshPlaylistFromPage
})()
