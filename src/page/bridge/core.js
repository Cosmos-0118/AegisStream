(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("core")) return

const originalFetch = window.fetch.bind(window)
const OriginalXHR = window.XMLHttpRequest
let reqCounter = 0
const pending = new Map()
const PLAYLIST_RELAY_TTL_MS = 45_000
const relayedPlaylists = new Map()

function playlistRelayKey(url) {
  if (typeof url !== "string" || !url) return null
  return url.split("?")[0]
}

function canRelayPlaylist(url) {
  const key = playlistRelayKey(url)
  if (!key) return false
  const lastAt = relayedPlaylists.get(key)
  if (!lastAt) return true
  return Date.now() - lastAt >= PLAYLIST_RELAY_TTL_MS
}

function markPlaylistRelayed(url) {
  const key = playlistRelayKey(url)
  if (!key) return
  relayedPlaylists.set(key, Date.now())
  if (relayedPlaylists.size > 200) {
    const first = relayedPlaylists.keys().next().value
    relayedPlaylists.delete(first)
  }
}

function clearPlaylistRelayDedup(url) {
  const key = playlistRelayKey(url)
  if (key) relayedPlaylists.delete(key)
}

function nextRequestId() {
  reqCounter += 1
  return `aegis-${Date.now()}-${reqCounter}`
}

function stripHash(url) {
  if (typeof url !== "string") return null
  return url.split("#")[0]
}

function getRequestDetails(input, init) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input?.url
  const method = (
    init?.method ||
    (input instanceof Request ? input.method : "GET") ||
    "GET"
  ).toUpperCase()
  const requestHeaders = new Headers(
    init?.headers || (input instanceof Request ? input.headers : undefined)
  )
  return {
    url: stripHash(url),
    method,
    hasRange: requestHeaders.has("range"),
    requestHeaders
  }
}

function requestRuntime(type, payload) {
  return new Promise((resolve) => {
    const requestId = nextRequestId()
    pending.set(requestId, resolve)
    window.postMessage(
      {
        __aegisstream: true,
        type,
        requestId,
        ...payload
      },
      "*"
    )
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId)
        resolve({ ok: false, hit: false, timeout: true })
      }
    }, type === "STORE_CHUNK_REQUEST" ? 12000 : type === "EXTENSION_FETCH_REQUEST" ? 65000 : 5000)
  })
}

function base64ToArrayBuffer(base64) {
  if (typeof base64 !== "string" || base64.length === 0) return null
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function resolveLookupBytes(lookup) {
  if (lookup?.bytes && typeof lookup.bytes.byteLength === "number") {
    return lookup.bytes
  }
  if (typeof lookup?.bytesBase64 === "string") {
    try {
      return base64ToArrayBuffer(lookup.bytesBase64)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Send a message to the content script without expecting a response.
 */
function notifyRuntime(type, payload) {
  window.postMessage({ __aegisstream: true, type, ...payload }, "*")
}

function logBridge(msg, level = "INFO") {
  notifyRuntime("DEBUG_LOG", { msg, level })
}

function monotonicNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

function reportRuntimeMetric(metricType, payload = {}) {
  notifyRuntime("RUNTIME_METRIC", { metricType, ...payload })
}

ns.extensionEnabled = true
ns.prefetchEnabled = true
ns.serveFromCache = true

ns.originalFetch = originalFetch
ns.OriginalXHR = OriginalXHR
ns.pending = pending
ns.relayedPlaylists = relayedPlaylists
ns.canRelayPlaylist = canRelayPlaylist
ns.markPlaylistRelayed = markPlaylistRelayed
ns.clearPlaylistRelayDedup = clearPlaylistRelayDedup
ns.PLAYLIST_RELAY_TTL_MS = PLAYLIST_RELAY_TTL_MS
ns.nextRequestId = nextRequestId
ns.stripHash = stripHash
ns.getRequestDetails = getRequestDetails
ns.requestRuntime = requestRuntime
ns.base64ToArrayBuffer = base64ToArrayBuffer
ns.resolveLookupBytes = resolveLookupBytes
ns.notifyRuntime = notifyRuntime
ns.logBridge = logBridge
ns.monotonicNow = monotonicNow
ns.reportRuntimeMetric = reportRuntimeMetric
})()
