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

const STORE_CHUNK_TIMEOUT_MS = 30_000
const STORE_CHUNK_RETRY_ATTEMPTS = 2
const STORE_CHUNK_RETRY_DELAY_MS = 80
const inflightChunkStores = new Map()

function requestRuntime(type, payload, transferables = []) {
  return new Promise((resolve) => {
    const requestId = nextRequestId()
    pending.set(requestId, resolve)
    const transfer =
      Array.isArray(transferables) && transferables.length > 0 ? transferables : []
    window.postMessage(
      {
        __aegisstream: true,
        type,
        requestId,
        ...payload
      },
      "*",
      transfer
    )
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId)
        resolve({
          ok: false,
          hit: false,
          timeout: true,
          error: "timeout"
        })
      }
    }, type === "STORE_CHUNK_REQUEST"
      ? STORE_CHUNK_TIMEOUT_MS
      : type === "EXTENSION_FETCH_REQUEST"
        ? 65000
        : 5000)
  })
}

function formatStoreChunkError(storeRes, caughtError) {
  if (caughtError) {
    const name = caughtError?.name || "Error"
    const message = caughtError?.message || String(caughtError)
    return `${name}: ${message}`
  }
  if (!storeRes) return "no-response"
  if (storeRes.timeout) return "timeout"
  const parts = []
  if (storeRes.error) parts.push(String(storeRes.error))
  if (storeRes.skipped) parts.push("skipped")
  if (storeRes.duplicate) parts.push("duplicate")
  return parts.length > 0 ? parts.join(",") : "unknown"
}

function isTransientStoreFailure(storeRes) {
  if (!storeRes || storeRes.ok) return false
  const error = formatStoreChunkError(storeRes).toLowerCase()
  return /runtime|timeout|serialize|message port|context invalidated|no-response|unknown/.test(
    error
  )
}

function storeInflightKey(payload) {
  const url = stripHash(payload?.url)
  const byteLength =
    typeof payload?.bytes?.byteLength === "number" ? payload.bytes.byteLength : 0
  return `${url || ""}|${byteLength}`
}

function cloneBytesForBridge(bytes) {
  if (!bytes || typeof bytes.byteLength !== "number") return null
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.slice().buffer
}

async function recoverStoreFromCache(payload) {
  const url = stripHash(payload?.url)
  if (!url) return null
  const lookup = await requestRuntime("CACHE_LOOKUP_REQUEST", {
    url,
    method: (payload?.method || "GET").toUpperCase(),
    hasRange: false
  }).catch(() => null)
  if (lookup?.ok && lookup.hit) {
    return { ok: true, recovered: true, duplicate: true }
  }
  return null
}

async function storeChunkFromPage(payload) {
  const inflightKey = storeInflightKey(payload)
  if (inflightChunkStores.has(inflightKey)) {
    return inflightChunkStores.get(inflightKey)
  }

  const run = (async () => {
    const bridgedBytes = cloneBytesForBridge(payload.bytes)
    const storeBase =
      bridgedBytes != null ? { ...payload, bytes: bridgedBytes } : { ...payload }
    let lastRes = { ok: false, error: "store-failed" }
    for (let attempt = 0; attempt < STORE_CHUNK_RETRY_ATTEMPTS; attempt += 1) {
      const storePayload = { ...storeBase }
      const transfer = []
      if (storePayload.bytes && typeof storePayload.bytes.byteLength === "number") {
        const buf =
          storePayload.bytes instanceof ArrayBuffer
            ? storePayload.bytes
            : storePayload.bytes.buffer
        if (buf) transfer.push(buf)
      }
      lastRes = await requestRuntime("STORE_CHUNK_REQUEST", storePayload, transfer)
      if (lastRes?.ok) {
        if (typeof ns.noteLocalCacheKey === "function") {
          ns.noteLocalCacheKey(payload.url)
        }
        return lastRes
      }
      if (bridgedBytes != null) {
        storeBase.bytes = cloneBytesForBridge(bridgedBytes)
      }
      if (!isTransientStoreFailure(lastRes) || attempt >= STORE_CHUNK_RETRY_ATTEMPTS - 1) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, STORE_CHUNK_RETRY_DELAY_MS * (attempt + 1)))
    }
    if (!lastRes?.ok && isTransientStoreFailure(lastRes)) {
      const recovered = await recoverStoreFromCache(payload)
      if (recovered?.ok) return recovered
    }
    return lastRes
  })()

  inflightChunkStores.set(inflightKey, run)
  try {
    return await run
  } finally {
    if (inflightChunkStores.get(inflightKey) === run) {
      inflightChunkStores.delete(inflightKey)
    }
  }
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
ns.formatStoreChunkError = formatStoreChunkError
ns.isTransientStoreFailure = isTransientStoreFailure
ns.storeChunkFromPage = storeChunkFromPage
ns.base64ToArrayBuffer = base64ToArrayBuffer
ns.resolveLookupBytes = resolveLookupBytes
ns.notifyRuntime = notifyRuntime
ns.logBridge = logBridge
ns.monotonicNow = monotonicNow
ns.reportRuntimeMetric = reportRuntimeMetric
})()
