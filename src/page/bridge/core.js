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
const STORE_CHUNK_RETRY_ATTEMPTS = 5
const STORE_CHUNK_RETRY_DELAY_MS = 120
const STORE_CHUNK_INVALIDATED_RETRY_ATTEMPTS = 8
const STORE_CHUNK_INVALIDATED_MAX_DELAY_MS = 2_400
const MAX_PENDING_STORE_AFTER_RECONNECT = 48

const CHUNK_CAPTURE_SOURCES = new Set([
  "xhr-sync",
  "xhr-load",
  "fetch-clone",
  "fetch-tee",
  "ump",
  "prefetch",
  "range-buffer",
  "cross-itag",
  "unknown"
])

function normalizeCaptureSource(source) {
  const normalized = String(source || "unknown").toLowerCase()
  return CHUNK_CAPTURE_SOURCES.has(normalized) ? normalized : "unknown"
}

function recordChunkStoreOutcome({ captureSource, ok, byteLength, aborted }) {
  if (aborted) return
  reportRuntimeMetric("chunk_store_outcome", {
    captureSource: normalizeCaptureSource(captureSource),
    ok: !!ok,
    byteLength: ok && Number.isFinite(byteLength) ? Math.max(0, Math.round(byteLength)) : 0
  })
}
/** @type {Map<string, { abortController: AbortController, promise: Promise<object> }>} */
const inflightChunkStores = new Map()
const pendingStoreRequestIds = new Set()
/** @type {object[]} */
const pendingStoreAfterReconnect = []
let extensionReconnectTimer = null
let lastExtensionReconnectAt = 0
let lastInvalidatedStoreWarnAt = 0

function abortedStoreResult() {
  return { ok: false, error: "aborted", aborted: true, skipped: true }
}

function isExtensionContextInvalidated(storeRes, caughtError) {
  const error = formatStoreChunkError(storeRes, caughtError).toLowerCase()
  return /context invalidated|extension context invalidated|receiving end does not exist/.test(
    error
  )
}

function scheduleExtensionReconnect(reason = "context-invalidated") {
  const now = Date.now()
  if (now - lastExtensionReconnectAt < 400) return
  if (extensionReconnectTimer) return
  extensionReconnectTimer = setTimeout(() => {
    extensionReconnectTimer = null
    lastExtensionReconnectAt = Date.now()
    notifyRuntime("REQUEST_BRIDGE_RECONNECT", { reason })
  }, 80)
}

function enqueuePendingStoreAfterReconnect(stablePayload) {
  if (!stablePayload?.url || !stablePayload?.bytes) return
  if (pendingStoreAfterReconnect.length >= MAX_PENDING_STORE_AFTER_RECONNECT) {
    pendingStoreAfterReconnect.shift()
  }
  pendingStoreAfterReconnect.push(stablePayload)
}

async function flushPendingStoresAfterReconnect() {
  if (!pendingStoreAfterReconnect.length) return 0
  const batch = pendingStoreAfterReconnect.splice(0, pendingStoreAfterReconnect.length)
  let flushed = 0
  for (const payload of batch) {
    const res = await storeChunkFromPage(payload).catch(() => ({ ok: false }))
    if (res?.ok) flushed += 1
  }
  if (flushed > 0) {
    logBridge(`Flushed ${flushed}/${batch.length} deferred chunk store(s) after reconnect`, "INFO")
  }
  return flushed
}

function cancelInflightChunkStores(reason = "teardown") {
  if (/visibility-pause|visibility-resume/.test(String(reason || ""))) {
    return 0
  }
  if (inflightChunkStores.size === 0) return 0
  const count = inflightChunkStores.size
  for (const ctx of inflightChunkStores.values()) {
    try {
      ctx.abortController.abort()
    } catch {
      // ignore
    }
  }
  inflightChunkStores.clear()
  for (const requestId of pendingStoreRequestIds) {
    const resolve = pending.get(requestId)
    if (resolve) {
      pending.delete(requestId)
      resolve(abortedStoreResult())
    }
  }
  pendingStoreRequestIds.clear()
  logBridge(
    `Stale session store guard: evicted ${count} in-flight write(s) (${reason})`,
    "WARN"
  )
  return count
}

function delayWithAbortSignal(ms, signal) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

function requestRuntime(type, payload, transferables = [], options = {}) {
  const signal = options?.signal
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(
        type === "STORE_CHUNK_REQUEST"
          ? abortedStoreResult()
          : { ok: false, hit: false, error: "aborted", aborted: true }
      )
      return
    }

    let outbound = payload
    if (type === "STORE_CHUNK_REQUEST" && payload?.bytes) {
      const transportBytes = wrapBytesForExtensionTransport(payload.bytes)
      if (!transportBytes) {
        resolve({ ok: false, error: "invalid-bytes" })
        return
      }
      outbound = { ...payload, bytes: transportBytes }
    }
    const requestId = nextRequestId()
    const trackStoreRequest = type === "STORE_CHUNK_REQUEST"
    if (trackStoreRequest) pendingStoreRequestIds.add(requestId)

    const timeoutMs =
      type === "STORE_CHUNK_REQUEST"
        ? STORE_CHUNK_TIMEOUT_MS
        : type === "EXTENSION_FETCH_REQUEST"
          ? 65000
          : 5000
    let timeoutId = null

    const settle = (response) => {
      if (timeoutId != null) clearTimeout(timeoutId)
      if (signal) signal.removeEventListener("abort", onAbort)
      if (trackStoreRequest) pendingStoreRequestIds.delete(requestId)
      resolve(response)
    }

    const settleAborted = () => {
      if (!pending.has(requestId)) return
      pending.delete(requestId)
      settle(
        type === "STORE_CHUNK_REQUEST"
          ? abortedStoreResult()
          : { ok: false, hit: false, error: "aborted", aborted: true }
      )
    }
    const onAbort = () => settleAborted()
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true })
    }

    pending.set(requestId, settle)

    // Never transfer ArrayBuffers on the store lane — structured clone only.
    const transfer =
      type === "STORE_CHUNK_REQUEST"
        ? []
        : Array.isArray(transferables) && transferables.length > 0
          ? transferables
          : []
    window.postMessage(
      {
        __aegisstream: true,
        type,
        requestId,
        ...outbound
      },
      "*",
      transfer
    )

    timeoutId = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId)
        settle({
          ok: false,
          hit: false,
          timeout: true,
          error: "timeout"
        })
      }
    }, timeoutMs)
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
  return /runtime|timeout|serialize|message port|context invalidated|relay-error|no-response|unknown/.test(
    error
  )
}

function storeRetryPlan(storeRes) {
  const invalidated = isExtensionContextInvalidated(storeRes)
  const attempts = invalidated ? STORE_CHUNK_INVALIDATED_RETRY_ATTEMPTS : STORE_CHUNK_RETRY_ATTEMPTS
  const baseDelay = invalidated ? 200 : STORE_CHUNK_RETRY_DELAY_MS
  return { invalidated, attempts, baseDelay }
}

function storeRetryDelayMs(baseDelay, attempt, invalidated) {
  const delay = baseDelay * 2 ** attempt
  return invalidated ? Math.min(STORE_CHUNK_INVALIDATED_MAX_DELAY_MS, delay) : delay
}

function storeInflightKey(payload) {
  const url = stripHash(payload?.url)
  const byteLength =
    typeof payload?.bytes?.byteLength === "number" ? payload.bytes.byteLength : 0
  return `${url || ""}|${byteLength}`
}

function isDetachedBuffer(bytes) {
  if (!bytes) return true
  try {
    if (bytes instanceof ArrayBuffer) {
      new Uint8Array(bytes)
      return false
    }
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return false
  } catch {
    return true
  }
}

function cloneBytesForBridge(bytes) {
  if (!bytes || isDetachedBuffer(bytes)) return null
  if (typeof bytes.byteLength !== "number" || bytes.byteLength <= 0) return null
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.slice().buffer
}

/** TypedArray wrapper so chrome.runtime.sendMessage preserves binary across the extension IPC boundary. */
function wrapBytesForExtensionTransport(bytes) {
  const copied = cloneBytesForBridge(bytes)
  if (!copied) return null
  return new Uint8Array(copied)
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
  const captureSource = normalizeCaptureSource(payload?.captureSource)
  const rawByteLength =
    payload?.bytes && typeof payload.bytes.byteLength === "number"
      ? payload.bytes.byteLength
      : null

  if (rawByteLength === 0) {
    logBridge(`zero-byte-chunk (${captureSource})`, "WARN")
  }

  const stableBytes = payload?.bytes ? cloneBytesForBridge(payload.bytes) : null
  if (!stableBytes) {
    recordChunkStoreOutcome({
      captureSource,
      ok: false,
      byteLength: rawByteLength || 0
    })
    return { ok: false, error: "invalid-bytes" }
  }
  const stablePayload = { ...payload, bytes: stableBytes, captureSource }

  const inflightKey = storeInflightKey(stablePayload)
  const existing = inflightChunkStores.get(inflightKey)
  if (existing) {
    return existing.promise
  }

  const abortController = new AbortController()
  const { signal } = abortController

  const run = (async () => {
    let lastRes = { ok: false, error: "store-failed" }
    let aborted = false
    try {
      if (signal.aborted) {
        aborted = true
        return abortedStoreResult()
      }

      let retryPlan = storeRetryPlan(lastRes)
      for (let attempt = 0; attempt < retryPlan.attempts; attempt += 1) {
        if (signal.aborted) {
          aborted = true
          return abortedStoreResult()
        }
        lastRes = await requestRuntime("STORE_CHUNK_REQUEST", stablePayload, [], { signal })
        if (lastRes?.aborted) {
          aborted = true
          return abortedStoreResult()
        }
        if (lastRes?.ok) {
          if (typeof ns.noteLocalCacheKey === "function") {
            ns.noteLocalCacheKey(stablePayload.url)
          }
          return lastRes
        }
        retryPlan = storeRetryPlan(lastRes)
        if (!isTransientStoreFailure(lastRes) || attempt >= retryPlan.attempts - 1) {
          break
        }
        if (retryPlan.invalidated) {
          scheduleExtensionReconnect("store-retry")
        }
        try {
          await delayWithAbortSignal(
            storeRetryDelayMs(retryPlan.baseDelay, attempt, retryPlan.invalidated),
            signal
          )
        } catch {
          aborted = true
          return abortedStoreResult()
        }
      }

      if (signal.aborted) {
        aborted = true
        return abortedStoreResult()
      }

      if (!lastRes?.ok && isTransientStoreFailure(lastRes) && !signal.aborted) {
        const recovered = await recoverStoreFromCache(stablePayload)
        if (recovered?.ok) {
          lastRes = recovered
          return recovered
        }
        if (isExtensionContextInvalidated(lastRes)) {
          enqueuePendingStoreAfterReconnect(stablePayload)
          scheduleExtensionReconnect("store-failed")
        }
      }
      return lastRes
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        aborted = true
        return abortedStoreResult()
      }
      throw error
    } finally {
      if (!aborted) {
        recordChunkStoreOutcome({
          captureSource,
          ok: !!lastRes?.ok,
          byteLength: stableBytes.byteLength,
          aborted: false
        })
      }
      const ctx = inflightChunkStores.get(inflightKey)
      if (ctx?.promise === run) {
        inflightChunkStores.delete(inflightKey)
      }
    }
  })()

  inflightChunkStores.set(inflightKey, { abortController, promise: run })
  return run
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
ns.cloneBytesForBridge = cloneBytesForBridge
ns.copyArrayBufferForBridge = cloneBytesForBridge
ns.wrapBytesForExtensionTransport = wrapBytesForExtensionTransport
ns.normalizeCaptureSource = normalizeCaptureSource
ns.storeChunkFromPage = storeChunkFromPage
ns.cancelInflightChunkStores = cancelInflightChunkStores
ns.flushPendingStoresAfterReconnect = flushPendingStoresAfterReconnect
ns.isExtensionContextInvalidated = isExtensionContextInvalidated
ns.base64ToArrayBuffer = base64ToArrayBuffer
ns.resolveLookupBytes = resolveLookupBytes
ns.notifyRuntime = notifyRuntime
ns.logBridge = logBridge
ns.monotonicNow = monotonicNow
ns.reportRuntimeMetric = reportRuntimeMetric
})()
