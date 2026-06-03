// ---------------------------------------------------------------------------
// AegisStream Content Script
// Acts as a relay between the MAIN world (page-bridge) and the extension's
// background service worker (ISOLATED world).
// ---------------------------------------------------------------------------

(() => {
if (typeof globalThis.claimAegisContentSlot === "function") {
  if (!globalThis.claimAegisContentSlot("relay")) {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:BridgeReady",
        reason: "reinject",
        pageUrl: location.href
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }
} else if (globalThis.__aegisContentRelayInstalled === true) {
  try {
    chrome.runtime.sendMessage({
      type: "AegisStream:BridgeReady",
      reason: "reinject",
      pageUrl: location.href
    })
  } catch {
    // Extension context may be invalidated
  }
  return
}

// ---------------------------------------------------------------------------
// Messages FROM background service worker → relay to page-bridge
// (prefetch commands, etc.)
// ---------------------------------------------------------------------------

function relaySettingsToPage(settings) {
  if (!settings || typeof settings !== "object") return
  window.postMessage(
    {
      __aegisstream: true,
      type: "SETTINGS_UPDATED",
      settings
    },
    "*"
  )
}

function notifyBridgeReady(reason = "startup") {
  try {
    chrome.runtime.sendMessage(
      {
        type: "AegisStream:BridgeReady",
        reason,
        pageUrl: location.href
      },
      (response) => {
        if (response?.settings) {
          relaySettingsToPage(response.settings)
        }
      }
    )
  } catch {
    // Extension context may be invalidated
  }
}

function relayExtensionFetchStreamToPage(message) {
  if (!message?.requestId) return
  if (message.type === "AegisStream:ExtensionFetchChunk") {
    const payload = {
      __aegisstream: true,
      type: "EXTENSION_FETCH_CHUNK",
      requestId: message.requestId,
      index: message.index
    }
    const copied = copyArrayBuffer(message.bytes)
    if (copied) {
      payload.bytes = copied
    } else if (typeof message.chunkBase64 === "string") {
      payload.chunkBase64 = message.chunkBase64
    }
    window.postMessage(payload, "*")
    return
  }
  if (message.type === "AegisStream:ExtensionFetchEnd") {
    window.postMessage(
      {
        __aegisstream: true,
        type: "EXTENSION_FETCH_END",
        requestId: message.requestId,
        ok: message.ok === true,
        error: message.error || null
      },
      "*"
    )
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "AegisStream:Ping") {
    sendResponse({ ok: true, ready: true, pageUrl: location.href })
    return true
  }

  if (
    message?.type === "AegisStream:ExtensionFetchChunk" ||
    message?.type === "AegisStream:ExtensionFetchEnd"
  ) {
    relayExtensionFetchStreamToPage(message)
    return false
  }

  if (message?.type === "AegisStream:PrefetchSegments" && message.urls) {
    window.postMessage({
      __aegisstream: true,
      type: "PREFETCH_SEGMENTS",
      urls: message.urls,
      networkGeneration: message.networkGeneration,
      playbackGeneration: message.playbackGeneration ?? message.networkGeneration,
      priority: message.priority || "low"
    }, "*")
    sendResponse({ ok: true })
    return true
  }

  if (message?.type === "AegisStream:CancelPrefetch") {
    window.postMessage({
      __aegisstream: true,
      type: "CANCEL_PREFETCH",
      networkGeneration: message.networkGeneration
    }, "*")
    sendResponse({ ok: true })
    return true
  }

  if (message?.type === "AegisStream:CacheRegistrySync" && message.payload) {
    window.postMessage({
      __aegisstream: true,
      type: "CACHE_REGISTRY_SYNC",
      payload: message.payload
    }, "*")
    sendResponse({ ok: true })
    return true
  }

  if (message?.type === "AegisStream:KnownSegments" && message.urls) {
    window.postMessage({
      __aegisstream: true,
      type: "KNOWN_SEGMENTS",
      urls: message.urls,
      playbackHint: message.playbackHint || null
    }, "*")
    sendResponse({ ok: true })
    return true
  }

  if (message?.type === "AegisStream:RefreshPlaylist" && message.url) {
    window.postMessage({
      __aegisstream: true,
      type: "REFRESH_PLAYLIST",
      url: message.url,
      generation: message.generation
    }, "*")
    sendResponse({ ok: true })
    return true
  }

  if (message?.type === "AegisStream:SettingsUpdated" && message.settings) {
    relaySettingsToPage(message.settings)
    sendResponse({ ok: true })
    return true
  }

  return false
})

notifyBridgeReady("startup")

window.addEventListener("pageshow", () => {
  notifyBridgeReady("pageshow")
})

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    notifyBridgeReady("visible")
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:TabVisibility",
        hidden: false,
        pageUrl: location.href
      })
    } catch {
      // Extension context may be invalidated
    }
  } else {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:TabVisibility",
        hidden: true,
        pageUrl: location.href
      })
    } catch {
      // Extension context may be invalidated
    }
  }
})

// ---------------------------------------------------------------------------
// Messages FROM page-bridge → relay to background service worker
// ---------------------------------------------------------------------------

function copyArrayBuffer(bytes) {
  if (!bytes) return null
  try {
    if (bytes instanceof ArrayBuffer) {
      if (bytes.byteLength <= 0) return null
      return bytes.slice(0)
    }
    if (typeof bytes.byteLength === "number" && bytes.buffer) {
      const length = bytes.byteLength
      if (length <= 0) return null
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + length)
    }
  } catch {
    return null
  }
  return null
}

/** Stay under chrome.runtime.sendMessage size limits (base64 expands ~4/3). */
const MAX_RELAY_STORE_BYTES = 16 * 1024 * 1024

/**
 * TypedArrays often arrive in the service worker as plain objects (wire=[object Object]).
 * Base64 is slower but survives structured clone reliably.
 */
function storeBytesForExtensionMessage(bytes) {
  const copied = copyArrayBuffer(bytes)
  if (!copied || copied.byteLength <= 0) return null
  if (copied.byteLength > MAX_RELAY_STORE_BYTES) return { error: "relay-oversized-bytes" }
  const bytesBase64 = arrayBufferToBase64(copied)
  if (!bytesBase64) return null
  return { bytesBase64 }
}

function arrayBufferToBase64(buffer) {
  if (!buffer || typeof buffer.byteLength !== "number") return null
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.__aegisstream !== true) return

  if (data.type === "CACHE_LOOKUP_REQUEST") {
    try {
      chrome.runtime.sendMessage(
        {
          type: "AegisStream:CacheLookup",
          url: data.url,
          method: data.method,
          hasRange: data.hasRange
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError
          let payload = runtimeError ? { ok: false, hit: false } : response || { ok: false, hit: false }
          if (payload?.hit && payload.bytes) {
            const copied = copyArrayBuffer(payload.bytes)
            if (copied) {
              payload = { ...payload, bytes: copied }
            } else {
              payload = { ok: false, hit: false, error: "cache-bytes-unavailable" }
            }
          }
          window.postMessage(
            {
              __aegisstream: true,
              type: "CACHE_LOOKUP_RESPONSE",
              requestId: data.requestId,
              response: payload
            },
            "*"
          )
        }
      )
    } catch {
      window.postMessage(
        {
          __aegisstream: true,
          type: "CACHE_LOOKUP_RESPONSE",
          requestId: data.requestId,
          response: { ok: false, hit: false }
        },
        "*"
      )
    }
    return
  }

  if (data.type === "INFLIGHT_PREFETCH_QUERY") {
    try {
      chrome.runtime.sendMessage(
        {
          type: "AegisStream:InflightPrefetchQuery",
          url: data.url
        },
        (response) => {
          const runtimeError = chrome.runtime.lastError
          window.postMessage(
            {
              __aegisstream: true,
              type: "INFLIGHT_PREFETCH_QUERY_RESPONSE",
              requestId: data.requestId,
              response: runtimeError
                ? { ok: false, inflight: false, error: runtimeError.message || "runtime-error" }
                : response || { ok: false, inflight: false }
            },
            "*"
          )
        }
      )
    } catch {
      window.postMessage(
        {
          __aegisstream: true,
          type: "INFLIGHT_PREFETCH_QUERY_RESPONSE",
          requestId: data.requestId,
          response: { ok: false, inflight: false, error: "relay-error" }
        },
        "*"
      )
    }
    return
  }

  if (data.type === "STORE_CHUNK_REQUEST") {
    try {
      const payload = {
        type: "AegisStream:StoreChunk",
        url: data.url,
        contentType: data.contentType,
        status: data.status,
        method: data.method,
        hasRange: data.hasRange,
        captureSource: data.captureSource
      }

      const encoded =
        storeBytesForExtensionMessage(data.bytes) ||
        (typeof data.bytesBase64 === "string" && data.bytesBase64.length > 0
          ? { bytesBase64: data.bytesBase64 }
          : null)
      if (!encoded || encoded.error) {
        window.postMessage(
          {
            __aegisstream: true,
            type: "STORE_CHUNK_RESPONSE",
            requestId: data.requestId,
            response: {
              ok: false,
              error: encoded?.error || "relay-missing-bytes"
            }
          },
          "*"
        )
        return
      }
      payload.bytesBase64 = encoded.bytesBase64

      chrome.runtime.sendMessage(
        payload,
        (response) => {
          const runtimeError = chrome.runtime.lastError
          window.postMessage(
            {
              __aegisstream: true,
              type: "STORE_CHUNK_RESPONSE",
              requestId: data.requestId,
              response: runtimeError
                ? { ok: false, error: runtimeError.message || "runtime-error" }
                : response || { ok: false, error: "no-response" }
            },
            "*"
          )
        }
      )
    } catch (error) {
      window.postMessage(
        {
          __aegisstream: true,
          type: "STORE_CHUNK_RESPONSE",
          requestId: data.requestId,
          response: {
            ok: false,
            error: error?.message ? `relay-error: ${error.message}` : "relay-error"
          }
        },
        "*"
      )
    }
    return
  }

  if (data.type === "EXTENSION_FETCH_REQUEST") {
    try {
      const payload = {
        type: "AegisStream:ExtensionFetch",
        requestId: data.requestId,
        url: data.url,
        method: data.method,
        headers: data.headers,
        source: data.source || "extension-fetch"
      }

      if (data.bytes && typeof data.bytes.byteLength === "number") {
        const bytesBase64 = arrayBufferToBase64(data.bytes)
        if (bytesBase64) payload.bytesBase64 = bytesBase64
      } else if (typeof data.bytesBase64 === "string") {
        payload.bytesBase64 = data.bytesBase64
      }

      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeError = chrome.runtime.lastError
        window.postMessage(
          {
            __aegisstream: true,
            type: "EXTENSION_FETCH_RESPONSE",
            requestId: data.requestId,
            response: runtimeError
              ? { ok: false, error: runtimeError.message || "runtime-error" }
              : response || { ok: false }
          },
          "*"
        )
      })
    } catch {
      window.postMessage(
        {
          __aegisstream: true,
          type: "EXTENSION_FETCH_RESPONSE",
          requestId: data.requestId,
          response: { ok: false, error: "send-failed" }
        },
        "*"
      )
    }
    return
  }

  if (data.type === "EXTENSION_FETCH_ABORT") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:ExtensionFetchAbort",
        requestId: data.requestId
      })
    } catch {
      // Ignored
    }
    return
  }

  // Relay playlist URL discoveries from page-bridge
  if (data.type === "PLAYLIST_DISCOVERED") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:PlaylistDiscovered",
        url: data.url
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  // Relay captured playlist content from page-bridge (primary path)
  if (data.type === "PLAYLIST_CONTENT") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:PlaylistContent",
        url: data.url,
        text: data.text,
        pageUrl: location.href,
        generation: data.generation
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "PLAYLIST_REFRESH_FAILED") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:PlaylistRefreshFailed",
        url: data.url,
        generation: data.generation,
        status: data.status
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  // Relay prefetch results from page-bridge
  if (data.type === "PREFETCH_RESULT") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:PrefetchResult",
        url: data.url,
        success: data.success,
        size: data.size,
        error: data.error,
        errorName: data.errorName || null,
        errorMessage: data.errorMessage || data.error || null,
        status: Number.isFinite(Number(data.status)) ? Number(data.status) : 0,
        fetchMode: data.fetchMode || "page",
        fetchPath: data.fetchPath || null,
        transient: data.transient === true,
        authFailure: data.authFailure === true,
        rateLimit: data.rateLimit === true,
        skipped: data.skipped || null,
        source: data.source || null,
        networkGeneration: Number.isFinite(Number(data.networkGeneration))
          ? Number(data.networkGeneration)
          : null
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "CACHE_SERVE_HIT" && data.url) {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:CacheServeHit",
        url: data.url
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "SPECULATIVE_REGISTER" && data.url) {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:SpeculativeRegister",
        url: data.url,
        source: data.source || "cross-itag",
        fromItag: data.fromItag || null,
        toItag: data.toItag || null,
        fromRung: data.fromRung || null,
        toRung: data.toRung || null
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "CHUNK_OBSERVED" && data.url) {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:ChunkObserved",
        url: data.url
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "FORCE_TELEPORT_ANCHOR") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:ForceTeleportAnchor",
        payload: {
          index: data.index,
          currentTimeSec: data.currentTimeSec,
          timestamp: data.timestamp,
          source: data.source || "dom-seeked",
          eventType: data.eventType || "seeked"
        }
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "LIVELINESS_PING") {
    try {
      chrome.runtime.sendMessage({ type: "AegisStream:LivelinessPing" })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "SCRUB_VELOCITY_PREFETCH") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:ScrubVelocityPrefetch",
        payload: {
          predictedIndex: data.predictedIndex,
          velocitySegPerSec: data.velocitySegPerSec,
          currentIndex: data.currentIndex
        }
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "TAB_VISIBILITY_PAUSE" || data.type === "TAB_VISIBILITY_RESUME") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:TabVisibility",
        hidden: data.type === "TAB_VISIBILITY_PAUSE" || data.hidden === true,
        pageUrl: location.href
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "SCRUBBING_TRAIN") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:ScrubbingTrain",
        payload: { active: data.active === true }
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "RUNTIME_METRIC" && data.metricType) {
    try {
      const payload = { ...data }
      delete payload.__aegisstream
      delete payload.type
      chrome.runtime.sendMessage({
        type: "AegisStream:RuntimeMetric",
        ...payload
      })
    } catch {
      // Ignored
    }
    return
  }

  if (data.type === "ARM_HEADER_HINTS" && data.targetUrl) {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:ArmHeaderHints",
        targetUrl: data.targetUrl,
        reason: data.reason || "hover"
      })
    } catch {
      // Extension context may be invalidated
    }
    return
  }

  if (data.type === "DEBUG_LOG") {
    try {
      chrome.runtime.sendMessage({
        type: "AegisStream:DebugLog",
        level: data.level || "INFO",
        msg: data.msg
      })
    } catch {
      // Ignored
    }
    return
  }
})

// ---------------------------------------------------------------------------
// Discover playlist URLs embedded in the page DOM
// ---------------------------------------------------------------------------

function discoverPlaylistsInPage() {
  const playlistPatterns = /https?:\/\/[^\s"'<>]+\.(m3u8|mpd)(\?[^\s"'<>]*)?/gi

  // Scan <source> and <video> tags
  const mediaTags = document.querySelectorAll("video[src], audio[src], source[src]")
  for (const tag of mediaTags) {
    const src = tag.getAttribute("src")
    if (src && /\.(m3u8|mpd)($|\?)/i.test(src)) {
      try {
        const url = new URL(src, location.href).toString()
        chrome.runtime.sendMessage({ type: "AegisStream:PlaylistDiscovered", url })
      } catch { /* ignore bad URLs */ }
    }
  }

  // Scan inline scripts for playlist URLs
  const scripts = document.querySelectorAll("script:not([src])")
  for (const script of scripts) {
    const text = script.textContent || ""
    const matches = text.matchAll(playlistPatterns)
    for (const match of matches) {
      try {
        chrome.runtime.sendMessage({
          type: "AegisStream:PlaylistDiscovered",
          url: match[0]
        })
      } catch { break }
    }
  }
}

// Run discovery after page loads
if (document.readyState === "complete" || document.readyState === "interactive") {
  setTimeout(discoverPlaylistsInPage, 1000)
} else {
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(discoverPlaylistsInPage, 1000)
  })
}

// Also watch for dynamically added video/source elements
const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue
      const sources = node.matches?.("video, audio, source")
        ? [node]
        : Array.from(node.querySelectorAll?.("video[src], audio[src], source[src]") || [])
      for (const el of sources) {
        const src = el.getAttribute("src")
        if (src && /\.(m3u8|mpd)($|\?)/i.test(src)) {
          try {
            const url = new URL(src, location.href).toString()
            chrome.runtime.sendMessage({ type: "AegisStream:PlaylistDiscovered", url })
          } catch { /* ignore */ }
        }
      }
    }
  }
})

const observerRoot = document.documentElement || document.body
if (observerRoot) {
  observer.observe(observerRoot, { childList: true, subtree: true })
} else {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const lateRoot = document.documentElement || document.body
      if (lateRoot) {
        observer.observe(lateRoot, { childList: true, subtree: true })
      }
    },
    { once: true }
  )
}
})()
