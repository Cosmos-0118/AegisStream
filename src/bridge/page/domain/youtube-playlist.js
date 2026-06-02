(() => {
var ns = (self.AegisPageBridge ||= {})
const {
  stripHash,
  requestRuntime,
  notifyRuntime,
  logBridge,
  monotonicNow,
  reportRuntimeMetric,
  rememberKnownUmpKey,
  knownSegments,
  relayedPlaylists,
  MAX_UMP_CAPTURE_BYTES,
  MAX_ACTIVE_UMP_CAPTURES
} = ns

function isYoutubeRangeUrl(url) {
  return window.AegisRangeBuffer && /\bgooglevideo\.com\/videoplayback\b/i.test(url)
}

function isYoutubeVideoPlaybackUrl(url) {
  return typeof url === "string" && /\bgooglevideo\.com\/videoplayback\b/i.test(url)
}

/**
 * Stable playback identity for cache keys. Signed query params (expire, sig, …)
 * rotate often; the POST body hash already identifies the segment payload.
 */
function getYoutubePlaybackIdentity(url) {
  if (!isYoutubeVideoPlaybackUrl(url)) return null
  try {
    const u = new URL(url, location.href)
    const parts = []
    const id = u.searchParams.get("id")
    const itag = u.searchParams.get("itag")
    const cpn = u.searchParams.get("cpn")
    if (id) parts.push(`id:${id}`)
    if (itag) parts.push(`itag:${itag}`)
    if (cpn) parts.push(`cpn:${cpn}`)
    if (parts.length > 0) return parts.join(";")
  } catch {
    // fall through
  }
  if (window.AegisRangeBuffer) {
    return window.AegisRangeBuffer.getStreamId(url)
  }
  return null
}

function formatUmpCacheKey(url, bodyHash) {
  const identity = getYoutubePlaybackIdentity(url) || "unknown"
  return `ump|${identity}|${bodyHash}`
}

async function sha1Hex(bytes) {
  if (!bytes || typeof bytes.byteLength !== "number") return null
  const digest = await crypto.subtle.digest("SHA-1", bytes)
  const out = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
  return out
}

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
  if (body instanceof FormData) {
    // Stable-enough representation for request fingerprinting.
    const pairs = []
    for (const [key, value] of body.entries()) {
      if (value instanceof File) {
        pairs.push(`${key}=file:${value.name}:${value.size}`)
      } else {
        pairs.push(`${key}=${String(value)}`)
      }
    }
    return new TextEncoder().encode(pairs.join("&")).buffer
  }
  return null
}

async function buildYoutubeUmpState(url, input, init) {
  if (!window.AegisRangeBuffer || !isYoutubeVideoPlaybackUrl(url)) return null

  let bodyBuffer = null
  if (init && Object.prototype.hasOwnProperty.call(init, "body")) {
    bodyBuffer = await bodyToArrayBuffer(init.body)
  } else if (input instanceof Request) {
    try {
      bodyBuffer = await input.clone().arrayBuffer()
    } catch {
      bodyBuffer = null
    }
  }

  if (!bodyBuffer || bodyBuffer.byteLength === 0) return null
  const digest = await sha1Hex(bodyBuffer)
  if (!digest) return null

  const bodyHash = digest.slice(0, 16)
  return {
    type: "ump",
    bodyHash,
    bodyLength: bodyBuffer.byteLength,
    cacheKey: formatUmpCacheKey(url, bodyHash)
  }
}

function buildYoutubeChunkState(url, headers = new Headers()) {
  if (!window.AegisRangeBuffer || !isYoutubeVideoPlaybackUrl(url)) return null
  const parsed = window.AegisRangeBuffer.parseRange(url, headers)
  if (!Number.isFinite(parsed.start)) return null

  const streamId = window.AegisRangeBuffer.getStreamId(url)
  return {
    type: parsed.type || "bytes",
    start: parsed.start,
    end: parsed.end,
    cacheKey: window.AegisRangeBuffer.formatCacheKey(streamId, parsed.start, parsed.end)
  }
}

function buildYoutubeChunkStateFromContentRange(url, contentRangeHeader) {
  if (!window.AegisRangeBuffer || !isYoutubeVideoPlaybackUrl(url)) return null
  const parsed = window.AegisRangeBuffer.parseContentRangeHeader(contentRangeHeader)
  if (!parsed) return null

  const streamId = window.AegisRangeBuffer.getStreamId(url)
  return {
    type: "bytes",
    start: parsed.start,
    end: parsed.end,
    cacheKey: window.AegisRangeBuffer.formatCacheKey(streamId, parsed.start, parsed.end)
  }
}

function buildYouTubePrefetchHeaders(requestHeaders, chunkState, fallbackByteLength = null) {
  const headers = new Headers(requestHeaders || undefined)
  if (
    chunkState?.type === "bytes" &&
    Number.isFinite(chunkState.start) &&
    !headers.has("range")
  ) {
    let end = chunkState.end
    if (!Number.isFinite(end) && Number.isFinite(fallbackByteLength)) {
      end = chunkState.start + fallbackByteLength - 1
    }
    if (Number.isFinite(end)) {
      headers.set("Range", `bytes=${chunkState.start}-${end}`)
    }
  }
  return headers
}

function cloneResponseForPlayer(response, stream) {
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  })
}

function isAbortLikeError(error) {
  const message = String(error?.message || "")
  const name = String(error?.name || "")
  return (
    name === "AbortError" ||
    name === "NetworkError" ||
    name === "InvalidStateError" ||
    /aborted/i.test(message) ||
    /BodyStreamBuffer was aborted/i.test(message) ||
    /The operation was aborted/i.test(message) ||
    /Failed to fetch/i.test(message) ||
    /Load failed/i.test(message) ||
    /networkerror/i.test(message) ||
    /stream.*(closed|lock)/i.test(message)
  )
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

function createUmpProxyResponseAndCache({
  networkResponse,
  cacheLookupUrl,
  contentType,
  urlForLog,
  captureForCache = true,
  requestStartedAt
}) {
  if (!networkResponse.body) {
    if (Number.isFinite(requestStartedAt)) {
      reportRuntimeMetric("request_first_byte", {
        source: "network",
        transport: "fetch",
        streamType: "ump",
        latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt))
      })
    }
    return networkResponse
  }

  const reader = networkResponse.body.getReader()
  const chunks = []
  let total = 0
  let truncated = false
  let aborted = false
  let streamErrored = false
  let streamErrorDetail = null
  let firstByteReported = false
  const maxBytes = MAX_UMP_CAPTURE_BYTES
  let captureReserved = false

  if (captureForCache) {
    if (ns.activeUmpCaptureCount >= MAX_ACTIVE_UMP_CAPTURES) {
      captureForCache = false
      const now = Date.now()
      if (now - ns.lastUmpCaptureBackpressureLogAt >= 5000) {
        ns.lastUmpCaptureBackpressureLogAt = now
        logBridge(
          `UMP cache capture throttled (active=${ns.activeUmpCaptureCount}, max=${MAX_ACTIVE_UMP_CAPTURES})`,
          "DEBUG"
        )
      }
      reportRuntimeMetric("youtube_ump_stream_outcome", {
        outcome: "capture_skipped",
        bytes: 0,
        reason: "backpressure"
      })
    } else {
      ns.activeUmpCaptureCount += 1
      captureReserved = true
    }
  }

  const proxyStream = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value || value.byteLength === 0) continue

          if (!firstByteReported && Number.isFinite(requestStartedAt)) {
            firstByteReported = true
            reportRuntimeMetric("request_first_byte", {
              source: "network",
              transport: "fetch",
              streamType: "ump",
              latencyMs: Math.max(0, Math.round(monotonicNow() - requestStartedAt))
            })
          }

          controller.enqueue(value)

          if (!captureForCache) continue
          if (truncated) continue
          total += value.byteLength
          if (total > maxBytes) {
            truncated = true
            chunks.length = 0
            continue
          }
          chunks.push(value)
        }
        controller.close()
      } catch (error) {
        aborted = isAbortLikeError(error)
        streamErrorDetail = `${error?.name || "Error"}: ${error?.message || "unknown"}`
        if (aborted) {
          try {
            controller.close()
          } catch {
            // ignored
          }
        } else {
          streamErrored = true
          // In YouTube UMP mode, hard stream errors often come from expected
          // transport recycling. Close softly so playback can immediately retry.
          try {
            controller.close()
          } catch {
            // ignored
          }
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // ignored
        }
        if (captureReserved) {
          ns.activeUmpCaptureCount = Math.max(0, ns.activeUmpCaptureCount - 1)
        }

        if (!captureForCache) {
          reportRuntimeMetric("youtube_ump_stream_outcome", {
            outcome: aborted ? "aborted" : streamErrored ? "error" : "passthrough",
            bytes: total,
            detail: streamErrorDetail,
            durationMs: Number.isFinite(requestStartedAt)
              ? Math.max(0, Math.round(monotonicNow() - requestStartedAt))
              : null
          })
          return
        }
        const MIN_UMP_CACHE_BYTES = 1024
        if (
          aborted ||
          streamErrored ||
          truncated ||
          total < MIN_UMP_CACHE_BYTES ||
          chunks.length === 0
        ) {
          let outcome = "empty"
          if (aborted) outcome = "aborted"
          else if (streamErrored) outcome = "error"
          else if (truncated) outcome = "truncated"
          reportRuntimeMetric("youtube_ump_stream_outcome", {
            outcome,
            bytes: total,
            detail: streamErrorDetail,
            durationMs: Number.isFinite(requestStartedAt)
              ? Math.max(0, Math.round(monotonicNow() - requestStartedAt))
              : null
          })
          return
        }

        const merged = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          merged.set(chunk, offset)
          offset += chunk.byteLength
        }

        void requestRuntime("STORE_CHUNK_REQUEST", {
          url: cacheLookupUrl,
          contentType,
          bytes: merged.buffer,
          status: 200,
          method: "GET",
          hasRange: false
        })
          .then((storeRes) => {
            if (storeRes?.ok) {
              rememberKnownUmpKey(cacheLookupUrl)
            } else {
              logBridge(
                `UMP chunk store failed (${storeRes?.error || "unknown"}): ${String(urlForLog).slice(-80)}`,
                "WARN"
              )
              reportRuntimeMetric("youtube_ump_stream_outcome", {
                outcome: "store_failed",
                bytes: total,
                detail: storeRes?.error || null,
                durationMs: Number.isFinite(requestStartedAt)
                  ? Math.max(0, Math.round(monotonicNow() - requestStartedAt))
                  : null
              })
              return
            }
            reportRuntimeMetric("youtube_ump_stream_outcome", {
              outcome: "completed",
              bytes: total,
              detail: null,
              durationMs: Number.isFinite(requestStartedAt)
                ? Math.max(0, Math.round(monotonicNow() - requestStartedAt))
                : null
            })
          })
          .catch(() => {
            logBridge(`UMP chunk store failed (runtime): ${String(urlForLog).slice(-80)}`, "WARN")
            reportRuntimeMetric("youtube_ump_stream_outcome", {
              outcome: "store_failed",
              bytes: total,
              detail: "runtime-error",
              durationMs: Number.isFinite(requestStartedAt)
                ? Math.max(0, Math.round(monotonicNow() - requestStartedAt))
                : null
            })
          })
      }
    },
    cancel(reason) {
      try {
        reader.cancel(reason)
      } catch {
        // ignored
      }
    }
  })

  return cloneResponseForPlayer(networkResponse, proxyStream)
}

function cacheNetworkStreamInBackground({
  stream,
  cacheLookupUrl,
  contentType,
  storeMethod,
  urlForLog,
  youtubeChunk,
  requestHeaders,
  sourceUrl
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

    const storeRes = await requestRuntime("STORE_CHUNK_REQUEST", {
      url: cacheLookupUrl,
      contentType,
      bytes: streamed.bytes,
      status: 200,
      method: storeMethod,
      hasRange: false
    }).catch(() => null)

    if (!storeRes?.ok) {
      logBridge(
        `Network chunk store failed (${storeRes?.error || "unknown"}): ${String(urlForLog).slice(-80)}`,
        "WARN"
      )
    }

    if (youtubeChunk && youtubeChunk.type !== "ump") {
      const prefetchHeaders = buildYouTubePrefetchHeaders(
        requestHeaders,
        youtubeChunk,
        streamed.byteLength
      )
      window.AegisRangeBuffer.triggerHeuristicPrefetch(
        sourceUrl,
        prefetchHeaders,
        notifyRuntime,
        requestRuntime
      )
    }
  })().catch((error) => {
    const message = error?.message || "unknown"
    const level = /aborted/i.test(message) ? "DEBUG" : "WARN"
    logBridge(`Background stream cache failed: ${message}`, level)
  })
}

function isLikelyChunk(url) {
  if (!url) return false
  
  // Exact match from parsed playlists
  const base = url.split("?")[0]
  if (knownSegments.has(base)) return true

  if (/\.(ts|m4s|mp4|cmf|webm|aac|m4a|m4v|fmp4)($|\?)/i.test(url)) return true
  if (/\b(segment|frag|chunk|Fragments)\b/i.test(url)) return true
  if (/googlevideo\.com\/videoplayback\b/i.test(url)) return true
  if (/akamaihd\.net\b.*\b(media|seg)\b/i.test(url)) return true
  return false
}

function isPlaylistUrl(url) {
  if (!url) return false
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

/**
 * If a response looks like a playlist, capture its text and relay to the
 * background for parsing. This is the critical path — the page context has
 * cookies/auth, so we capture here instead of re-fetching from the SW.
 */
function maybeCapturePlaylist(url, contentType, responseClone) {
  if (!url) return
  // Dedupe
  const key = url.split("?")[0] // rough dedup key
  if (relayedPlaylists.has(key)) return

  const isUrlMatch = isPlaylistUrl(url)
  const isCtMatch = isPlaylistContentType(contentType)

  if (!isUrlMatch && !isCtMatch) return

  relayedPlaylists.add(key)
  // Limit dedup set size
  if (relayedPlaylists.size > 200) {
    const first = relayedPlaylists.values().next().value
    relayedPlaylists.delete(first)
  }

  responseClone.text().then((text) => {
    if (!text || text.length < 10) return
    // Verify it actually looks like a playlist
    if (!isUrlMatch && !looksLikePlaylistBody(text)) return

    notifyRuntime("PLAYLIST_CONTENT", { url, text })
  }).catch(() => {})
}

ns.isYoutubeRangeUrl = isYoutubeRangeUrl
ns.isYoutubeVideoPlaybackUrl = isYoutubeVideoPlaybackUrl
ns.getYoutubePlaybackIdentity = getYoutubePlaybackIdentity
ns.formatUmpCacheKey = formatUmpCacheKey
ns.sha1Hex = sha1Hex
ns.bodyToArrayBuffer = bodyToArrayBuffer
ns.buildYoutubeUmpState = buildYoutubeUmpState
ns.buildYoutubeChunkState = buildYoutubeChunkState
ns.buildYoutubeChunkStateFromContentRange = buildYoutubeChunkStateFromContentRange
ns.buildYouTubePrefetchHeaders = buildYouTubePrefetchHeaders
ns.cloneResponseForPlayer = cloneResponseForPlayer
ns.isAbortLikeError = isAbortLikeError
ns.readStreamToArrayBuffer = readStreamToArrayBuffer
ns.createUmpProxyResponseAndCache = createUmpProxyResponseAndCache
ns.cacheNetworkStreamInBackground = cacheNetworkStreamInBackground
ns.isLikelyChunk = isLikelyChunk
ns.isPlaylistUrl = isPlaylistUrl
ns.isPlaylistContentType = isPlaylistContentType
ns.looksLikePlaylistBody = looksLikePlaylistBody
ns.maybeCapturePlaylist = maybeCapturePlaylist
})()
