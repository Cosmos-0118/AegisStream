(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("message-bridge")) return

const { prefetchSegmentsFromPage, pending, refreshPlaylistFromPage, cancelPrefetchRunway } = ns

const knownSegments = new Set()

window.addEventListener("message", (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.__aegisstream !== true) return

  // Receive known segment URLs from background
  if (data.type === "KNOWN_SEGMENTS" && data.urls) {
    for (const u of data.urls) {
      knownSegments.add(u.split("?")[0])
    }
    // Keep size reasonable to avoid memory leaks
    if (knownSegments.size > 2000) {
      const toDelete = Array.from(knownSegments).slice(0, 500)
      toDelete.forEach(k => knownSegments.delete(k))
    }
    return
  }

  // Handle prefetch commands from background (via content script)
  if (data.type === "PREFETCH_SEGMENTS" && data.urls) {
    void prefetchSegmentsFromPage(data.urls)
    return
  }

  if (data.type === "REFRESH_PLAYLIST" && data.url) {
    if (typeof cancelPrefetchRunway === "function") {
      cancelPrefetchRunway()
    }
    void refreshPlaylistFromPage(data.url)
    return
  }

  if (data.type === "EXTENSION_FETCH_CHUNK" && data.requestId) {
    if (typeof ns.onExtensionFetchChunk === "function") {
      ns.onExtensionFetchChunk(data.requestId, data.chunkBase64)
    }
    return
  }

  if (data.type === "EXTENSION_FETCH_END" && data.requestId) {
    if (typeof ns.onExtensionFetchEnd === "function") {
      ns.onExtensionFetchEnd(data.requestId, { ok: data.ok === true, error: data.error })
    }
    return
  }

  if (data.type === "EXTENSION_FETCH_RESPONSE" && data.requestId) {
    if (data.response?.streaming === true) {
      if (typeof ns.onExtensionFetchStreamMeta === "function") {
        ns.onExtensionFetchStreamMeta(data.requestId, data.response)
      }
      return
    }
    if (
      typeof ns.isExtensionFetchInFlight === "function" &&
      ns.isExtensionFetchInFlight(data.requestId) &&
      typeof ns.onExtensionFetchEnd === "function"
    ) {
      ns.onExtensionFetchEnd(data.requestId, {
        ok: data.response?.ok === true,
        error: data.response?.error || "extension fetch failed"
      })
      return
    }
  }

  // Handle response messages for pending requests
  if (!data.requestId || !pending.has(data.requestId)) return
  if (!data.type || !data.type.endsWith("_RESPONSE")) return
  const resolve = pending.get(data.requestId)
  pending.delete(data.requestId)
  resolve(data.response || { ok: false, hit: false })
})

ns.knownSegments = knownSegments
})()
