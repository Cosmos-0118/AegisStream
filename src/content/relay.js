// ---------------------------------------------------------------------------
// AegisStream Content Script
// Acts as a relay between the MAIN world (page-bridge) and the extension's
// background service worker (ISOLATED world).
// ---------------------------------------------------------------------------

(() => {
/** Bumped when a stale relay instance is replaced after extension reload. */
globalThis.__aegisRelayGeneration = (globalThis.__aegisRelayGeneration || 0) + 1

/** After extension reload, orphaned relays must stop calling chrome.runtime. */
let relayExtensionContextDead = false

function normalizeRelayError(error) {
  if (error == null) return ""
  if (typeof error === "string") return error
  if (typeof error?.message === "string") return error.message
  return String(error)
}

function isOrphanedExtensionContext(message) {
  const msg = normalizeRelayError(message).toLowerCase()
  return msg.includes("extension context invalidated") || msg.includes("context invalidated")
}

/** SW cold-start / no listener yet — retry later, do not permanently retire the relay. */
function isTransientRuntimeUnavailable(message) {
  const msg = normalizeRelayError(message).toLowerCase()
  return msg.includes("receiving end does not exist")
}

function isExtensionContextInvalidated(message) {
  return isOrphanedExtensionContext(message) || isTransientRuntimeUnavailable(message)
}

function markRelayExtensionContextDead(message) {
  if (!isOrphanedExtensionContext(message)) return
  relayExtensionContextDead = true
}

function canReachExtensionRuntime() {
  if (relayExtensionContextDead) return false
  try {
    return !!(chrome.runtime && chrome.runtime.id)
  } catch (error) {
    if (isOrphanedExtensionContext(normalizeRelayError(error))) {
      markRelayExtensionContextDead(normalizeRelayError(error))
    }
    return false
  }
}

function dispatchToBackgroundWorker(message, callback, activeGeneration) {
  if (!isActiveRelayInstance(activeGeneration)) {
    if (callback) callback(undefined, "relay-superseded")
    return
  }
  if (relayExtensionContextDead) {
    if (callback) callback(undefined, "Extension context invalidated.")
    return
  }
  if (!canReachExtensionRuntime()) {
    if (callback) callback(undefined, "runtime-unavailable")
    return
  }
  try {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError
      if (runtimeError) {
        const msg = runtimeError.message || String(runtimeError)
        markRelayExtensionContextDead(msg)
        if (callback) callback(undefined, msg)
        return
      }
      if (callback) callback(response, null)
    })
  } catch (error) {
    const msg = normalizeRelayError(error)
    markRelayExtensionContextDead(msg)
    if (callback) callback(undefined, msg)
  }
}

function relayToBackground(message, activeGeneration) {
  dispatchToBackgroundWorker(message, undefined, activeGeneration)
}

function forceClaimRelaySlot() {
  try {
    const armed =
      globalThis.__aegisContentArmed ||
      (globalThis.__aegisContentArmed = Object.create(null))
    armed.relay = true
  } catch {
    // ignore
  }
}

function isActiveRelayInstance(activeGeneration) {
  return activeGeneration === globalThis.__aegisRelayGeneration
}

function isDuplicateRelayInstall() {
  if (typeof globalThis.claimAegisContentSlot === "function") {
    return !globalThis.claimAegisContentSlot("relay")
  }
  return globalThis.__aegisContentRelayInstalled === true
}

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

function postExtensionRecoveredToPage(reason = "extension-recovered") {
  window.postMessage(
    {
      __aegisstream: true,
      type: "EXTENSION_RECOVERED",
      reason
    },
    "*"
  )
}

function notifyBridgeReady(reason = "startup", activeGeneration) {
  if (!isActiveRelayInstance(activeGeneration) || relayExtensionContextDead) return
  dispatchToBackgroundWorker(
    {
      type: "AegisStream:BridgeReady",
      reason,
      pageUrl: location.href
    },
    (response, err) => {
      if (err) return
      if (response?.settings) {
        relaySettingsToPage(response.settings)
      }
      postExtensionRecoveredToPage(reason)
    },
    activeGeneration
  )
}

function isPassiveBrowsePageUrl(pageUrl = location.href) {
  try {
    const host = new URL(pageUrl).hostname.toLowerCase()
    if (host === "twitch.tv" || host.endsWith(".twitch.tv")) return false
    return true
  } catch {
    return true
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

function discoverPlaylistsInPage(activeGeneration) {
  if (!isActiveRelayInstance(activeGeneration) || relayExtensionContextDead) return
  const playlistPatterns = /https?:\/\/[^\s"'<>]+\.(m3u8|mpd)(\?[^\s"'<>]*)?/gi

  const mediaTags = document.querySelectorAll("video[src], audio[src], source[src]")
  for (const tag of mediaTags) {
    const src = tag.getAttribute("src")
    if (src && /\.(m3u8|mpd)($|\?)/i.test(src)) {
      try {
        const url = new URL(src, location.href).toString()
        relayToBackground({ type: "AegisStream:PlaylistDiscovered", url }, activeGeneration)
      } catch {
        // ignore bad URLs
      }
    }
  }

  const scripts = document.querySelectorAll("script:not([src])")
  for (const script of scripts) {
    const text = script.textContent || ""
    const matches = text.matchAll(playlistPatterns)
    for (const match of matches) {
      try {
        relayToBackground(
          {
            type: "AegisStream:PlaylistDiscovered",
            url: match[0]
          },
          activeGeneration
        )
      } catch {
        break
      }
    }
  }
}

function installRelay(activeGeneration) {
  function relay(message) {
    relayToBackground(message, activeGeneration)
  }

  function dispatch(message, callback) {
    dispatchToBackgroundWorker(message, callback, activeGeneration)
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isActiveRelayInstance(activeGeneration)) return false

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

    if (message?.type === "AegisStream:BufferLoadPush") {
      window.postMessage(
        {
          __aegisstream: true,
          type: "BUFFER_LOAD_PUSH",
          tier: message.tier || null,
          runwaySec: message.runwaySec,
          healthScore: message.healthScore
        },
        "*"
      )
      sendResponse({ ok: true })
      return true
    }

    if (message?.type === "AegisStream:PrefetchSegments" && message.urls) {
      window.postMessage(
        {
          __aegisstream: true,
          type: "PREFETCH_SEGMENTS",
          urls: message.urls,
          networkGeneration: message.networkGeneration,
          playbackGeneration: message.playbackGeneration ?? message.networkGeneration,
          priority: message.priority || "low"
        },
        "*"
      )
      sendResponse({ ok: true })
      return true
    }

    if (message?.type === "AegisStream:CancelPrefetch") {
      window.postMessage(
        {
          __aegisstream: true,
          type: "CANCEL_PREFETCH",
          networkGeneration: message.networkGeneration,
          // Scoped abort: fetches near the playhead survive (rescue keep-window).
          keepUrls: Array.isArray(message.keepUrls) ? message.keepUrls : []
        },
        "*"
      )
      sendResponse({ ok: true })
      return true
    }

    if (message?.type === "AegisStream:CacheRegistrySync" && message.payload) {
      window.postMessage(
        {
          __aegisstream: true,
          type: "CACHE_REGISTRY_SYNC",
          payload: message.payload
        },
        "*"
      )
      sendResponse({ ok: true })
      return true
    }

    if (message?.type === "AegisStream:ResetSeekingState") {
      window.postMessage(
        {
          __aegisstream: true,
          type: "RESET_SEEKING_STATE",
          reason: message.reason || "manifest-reset",
          anchorIndex:
            typeof message.anchorIndex === "number" ? message.anchorIndex : null,
          variantSwitchGraceUntil:
            typeof message.variantSwitchGraceUntil === "number"
              ? message.variantSwitchGraceUntil
              : null
        },
        "*"
      )
      sendResponse({ ok: true })
      return true
    }

    if (message?.type === "AegisStream:KnownSegments" && message.urls) {
      window.postMessage(
        {
          __aegisstream: true,
          type: "KNOWN_SEGMENTS",
          urls: message.urls,
          playbackHint: message.playbackHint || null,
          resetSeeking: message.resetSeeking === true,
          anchorIndex:
            typeof message.anchorIndex === "number" ? message.anchorIndex : null,
          reason: message.reason || null
        },
        "*"
      )
      sendResponse({ ok: true })
      return true
    }

    if (message?.type === "AegisStream:RefreshPlaylist" && message.url) {
      window.postMessage(
        {
          __aegisstream: true,
          type: "REFRESH_PLAYLIST",
          url: message.url,
          generation: message.generation
        },
        "*"
      )
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

  notifyBridgeReady("startup", activeGeneration)

  window.addEventListener("pageshow", () => {
    if (!isActiveRelayInstance(activeGeneration)) return
    notifyBridgeReady("pageshow", activeGeneration)
  })

  document.addEventListener("visibilitychange", () => {
    if (!isActiveRelayInstance(activeGeneration) || relayExtensionContextDead) return
    if (document.visibilityState === "visible") {
      if (!isPassiveBrowsePageUrl()) {
        notifyBridgeReady("visible", activeGeneration)
      }
      relay(
        {
          type: "AegisStream:TabVisibility",
          hidden: false,
          pageUrl: location.href
        }
      )
    } else {
      relay(
        {
          type: "AegisStream:TabVisibility",
          hidden: true,
          pageUrl: location.href
        }
      )
    }
  })

  window.addEventListener("message", (event) => {
    if (!isActiveRelayInstance(activeGeneration)) return
    if (event.source !== window) return
    const data = event.data
    if (!data || data.__aegisstream !== true) return

    if (data.type === "REQUEST_BRIDGE_RECONNECT") {
      if (isPassiveBrowsePageUrl()) return
      notifyBridgeReady(data.reason || "store-recovery", activeGeneration)
      return
    }

    if (data.type === "CACHE_LOOKUP_REQUEST") {
      dispatch(
        {
          type: "AegisStream:CacheLookup",
          url: data.url,
          method: data.method,
          hasRange: data.hasRange
        },
        (response, err) => {
          let payload = err ? { ok: false, hit: false } : response || { ok: false, hit: false }
          if (payload?.hit && payload.bytes) {
            const copied = copyArrayBuffer(payload.bytes)
            if (copied) {
              payload = { ...payload, bytes: copied }
            } else if (typeof payload.bytesBase64 === "string" && payload.bytesBase64.length > 0) {
              // ArrayBuffer neutered during IPC — fall back to base64.
              // The page's resolveLookupBytes() will decode it.
              payload = {
                ok: payload.ok,
                hit: payload.hit,
                contentType: payload.contentType,
                bytesBase64: payload.bytesBase64,
                byteLength: payload.byteLength
              }
            } else {
              payload = { ok: false, hit: false, error: "cache-bytes-unavailable" }
            }
          } else if (payload?.hit && !payload.bytes && typeof payload.bytesBase64 === "string" && payload.bytesBase64.length > 0) {
            // BG sent only base64 (no raw bytes survived) — pass through.
            payload = {
              ok: payload.ok,
              hit: payload.hit,
              contentType: payload.contentType,
              bytesBase64: payload.bytesBase64,
              byteLength: payload.byteLength
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
      return
    }

    if (data.type === "INFLIGHT_PREFETCH_QUERY") {
      dispatch(
        {
          type: "AegisStream:InflightPrefetchQuery",
          url: data.url
        },
        (response, err) => {
          window.postMessage(
            {
              __aegisstream: true,
              type: "INFLIGHT_PREFETCH_QUERY_RESPONSE",
              requestId: data.requestId,
              response: err
                ? { ok: false, inflight: false, error: err }
                : response || { ok: false, inflight: false }
            },
            "*"
          )
        }
      )
      return
    }

    if (data.type === "STORE_CHUNK_REQUEST") {
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

      dispatch(payload, (response, err) => {
        window.postMessage(
          {
            __aegisstream: true,
            type: "STORE_CHUNK_RESPONSE",
            requestId: data.requestId,
            response: err
              ? {
                  ok: false,
                  error: err,
                  transient: isExtensionContextInvalidated(err)
                }
              : response || { ok: false, error: "no-response" }
          },
          "*"
        )
      })
      return
    }

    if (data.type === "EXTENSION_FETCH_REQUEST") {
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

      dispatch(payload, (response, err) => {
        window.postMessage(
          {
            __aegisstream: true,
            type: "EXTENSION_FETCH_RESPONSE",
            requestId: data.requestId,
            response: err
              ? { ok: false, error: err }
              : response || { ok: false }
          },
          "*"
        )
      })
      return
    }

    if (data.type === "EXTENSION_FETCH_ABORT") {
      relay({
        type: "AegisStream:ExtensionFetchAbort",
        requestId: data.requestId
      })
      return
    }

    if (data.type === "PLAYLIST_DISCOVERED") {
      relay({
        type: "AegisStream:PlaylistDiscovered",
        url: data.url
      })
      return
    }

    if (data.type === "PLAYLIST_CONTENT") {
      relay({
        type: "AegisStream:PlaylistContent",
        url: data.url,
        text: data.text,
        pageUrl: location.href,
        generation: data.generation
      })
      return
    }

    if (data.type === "PLAYLIST_REFRESH_FAILED") {
      relay({
        type: "AegisStream:PlaylistRefreshFailed",
        url: data.url,
        generation: data.generation,
        status: data.status
      })
      return
    }

    if (data.type === "INFLIGHT_WIRE_RESOLVE" && data.url) {
      const encoded =
        storeBytesForExtensionMessage(data.bytes) ||
        (typeof data.bytesBase64 === "string" && data.bytesBase64.length > 0
          ? { bytesBase64: data.bytesBase64 }
          : null)
      if (!encoded || encoded.error) return
      relay({
        type: "AegisStream:InflightWireResolve",
        url: data.url,
        contentType: data.contentType || "application/octet-stream",
        bytesBase64: encoded.bytesBase64
      })
      return
    }

    if (data.type === "PREFETCH_RESULT") {
      relay({
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
      return
    }

    if (data.type === "CACHE_SERVE_HIT" && data.url) {
      relay({
        type: "AegisStream:CacheServeHit",
        url: data.url
      })
      return
    }

    if (data.type === "SPECULATIVE_REGISTER" && data.url) {
      relay({
        type: "AegisStream:SpeculativeRegister",
        url: data.url,
        source: data.source || "speculative",
        fromItag: data.fromItag || null,
        toItag: data.toItag || null,
        fromRung: data.fromRung || null,
        toRung: data.toRung || null
      })
      return
    }

    if (data.type === "CHUNK_OBSERVED" && data.url) {
      relay({
        type: "AegisStream:ChunkObserved",
        url: data.url
      })
      return
    }

    if (data.type === "FORCE_TELEPORT_ANCHOR") {
      relay({
        type: "AegisStream:ForceTeleportAnchor",
        payload: {
          index: data.index,
          currentTimeSec: data.currentTimeSec,
          timestamp: data.timestamp,
          source: data.source || "dom-seeked",
          eventType: data.eventType || "seeked"
        }
      })
      return
    }

    if (data.type === "LIVELINESS_PING") {
      relay({ type: "AegisStream:LivelinessPing" })
      return
    }

    if (data.type === "SCRUB_VELOCITY_PREFETCH") {
      relay({
        type: "AegisStream:ScrubVelocityPrefetch",
        payload: {
          predictedIndex: data.predictedIndex,
          velocitySegPerSec: data.velocitySegPerSec,
          currentIndex: data.currentIndex
        }
      })
      return
    }

    if (data.type === "TAB_VISIBILITY_PAUSE" || data.type === "TAB_VISIBILITY_RESUME") {
      relay({
        type: "AegisStream:TabVisibility",
        hidden: data.type === "TAB_VISIBILITY_PAUSE" || data.hidden === true,
        pageUrl: location.href
      })
      return
    }

    if (data.type === "UNIFIED_SEEK_STATE") {
      const wire = typeof data.wire === "string" ? data.wire : null
      if (!wire) return
      relay({
        type: "AegisStream:UnifiedSeekState",
        wire
      })
      return
    }

    if (data.type === "PLAYER_PAUSED") {
      relay({
        type: "AegisStream:RuntimeMetric",
        metricType: "player_paused",
        currentTime: data.timeSec
      })
      return
    }

    if (data.type === "SCRUBBING_TRAIN") {
      relay({
        type: "AegisStream:ScrubbingTrain",
        payload: { active: data.active === true }
      })
      return
    }

    if (data.type === "INFLIGHT_CONSUMER_MUTATE" && data.url) {
      relay({
        type: "AegisStream:InflightConsumerMutate",
        url: data.url,
        delta: data.delta
      })
      return
    }

    if (data.type === "RUNTIME_METRIC" && data.metricType) {
      const metricPayload = { ...data }
      delete metricPayload.__aegisstream
      delete metricPayload.type
      relay({
        type: "AegisStream:RuntimeMetric",
        ...metricPayload
      })
      return
    }

    if (data.type === "ARM_HEADER_HINTS" && data.targetUrl) {
      relay({
        type: "AegisStream:ArmHeaderHints",
        targetUrl: data.targetUrl,
        reason: data.reason || "hover"
      })
      return
    }

    if (data.type === "DEBUG_LOG") {
      relay({
        type: "AegisStream:DebugLog",
        level: data.level || "INFO",
        msg: data.msg
      })
    }
  })

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(() => discoverPlaylistsInPage(activeGeneration), 1000)
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      setTimeout(() => discoverPlaylistsInPage(activeGeneration), 1000)
    })
  }

  const observer = new MutationObserver((mutations) => {
    if (!isActiveRelayInstance(activeGeneration) || relayExtensionContextDead) return
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
              relay({ type: "AegisStream:PlaylistDiscovered", url })
            } catch {
              // ignore
            }
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
}

function startRelay() {
  const activeGeneration = globalThis.__aegisRelayGeneration
  if (!isDuplicateRelayInstall()) {
    globalThis.__aegisContentRelayInstalled = true
    installRelay(activeGeneration)
    return
  }

  dispatchToBackgroundWorker(
    { type: "AegisStream:Ping" },
    (response, err) => {
      if (!err && response?.ok) {
        notifyBridgeReady("reinject", activeGeneration)
        return
      }
      if (err && isTransientRuntimeUnavailable(err)) {
        notifyBridgeReady("reinject", activeGeneration)
        return
      }
      if (err && !isOrphanedExtensionContext(err)) {
        return
      }
      globalThis.__aegisRelayGeneration = (globalThis.__aegisRelayGeneration || 0) + 1
      forceClaimRelaySlot()
      relayExtensionContextDead = false
      globalThis.__aegisContentRelayInstalled = true
      installRelay(globalThis.__aegisRelayGeneration)
    },
    activeGeneration
  )
}

startRelay()
})()
