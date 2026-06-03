// ---------------------------------------------------------------------------
// AegisStream Content Script
// Acts as a relay between the MAIN world (page-bridge) and the extension's
// background service worker (ISOLATED world).
// ---------------------------------------------------------------------------

(() => {
if (globalThis.__aegisContentRelayInstalled === true) {
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
globalThis.__aegisContentRelayInstalled = true

// ---------------------------------------------------------------------------
// Messages FROM background service worker → relay to page-bridge
// (prefetch commands, etc.)
// ---------------------------------------------------------------------------

function notifyBridgeReady(reason = "startup") {
  try {
    chrome.runtime.sendMessage({
      type: "AegisStream:BridgeReady",
      reason,
      pageUrl: location.href
    })
  } catch {
    // Extension context may be invalidated
  }
}

function relayExtensionFetchStreamToPage(message) {
  if (!message?.requestId) return
  if (message.type === "AegisStream:ExtensionFetchChunk") {
    window.postMessage(
      {
        __aegisstream: true,
        type: "EXTENSION_FETCH_CHUNK",
        requestId: message.requestId,
        index: message.index,
        chunkBase64: message.chunkBase64
      },
      "*"
    )
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
      urls: message.urls
    }, "*")
    sendResponse({ ok: true })
    return true
  }

  if (message?.type === "AegisStream:KnownSegments" && message.urls) {
    window.postMessage({
      __aegisstream: true,
      type: "KNOWN_SEGMENTS",
      urls: message.urls
    }, "*")
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
  }
})

// ---------------------------------------------------------------------------
// Messages FROM page-bridge → relay to background service worker
// ---------------------------------------------------------------------------

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
          window.postMessage(
            {
              __aegisstream: true,
              type: "CACHE_LOOKUP_RESPONSE",
              requestId: data.requestId,
              response: runtimeError ? { ok: false, hit: false } : response || { ok: false, hit: false }
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

  if (data.type === "STORE_CHUNK_REQUEST") {
    try {
      const payload = {
        type: "AegisStream:StoreChunk",
        url: data.url,
        contentType: data.contentType,
        status: data.status,
        method: data.method,
        hasRange: data.hasRange
      }

      if (data.bytes && typeof data.bytes.byteLength === "number") {
        const bytesBase64 = arrayBufferToBase64(data.bytes)
        if (!bytesBase64) {
          window.postMessage(
            {
              __aegisstream: true,
              type: "STORE_CHUNK_RESPONSE",
              requestId: data.requestId,
              response: { ok: false, error: "serialize-failed" }
            },
            "*"
          )
          return
        }
        payload.bytesBase64 = bytesBase64
      } else if (typeof data.bytesBase64 === "string") {
        payload.bytesBase64 = data.bytesBase64
      }

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
                : response || { ok: false }
            },
            "*"
          )
        }
      )
    } catch {
      window.postMessage(
        {
          __aegisstream: true,
          type: "STORE_CHUNK_RESPONSE",
          requestId: data.requestId,
          response: { ok: false }
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
        headers: data.headers
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
        pageUrl: location.href
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
        transient: data.transient === true,
        skipped: data.skipped || null
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
