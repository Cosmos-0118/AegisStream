(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("message-bridge")) return

const { prefetchSegmentsFromPage, pending, refreshPlaylistFromPage, cancelPrefetchRunway } = ns

function applyRuntimeSettings(settings) {
  if (!settings || typeof settings !== "object") return
  ns.extensionEnabled = settings.enabled !== false
  ns.prefetchEnabled = settings.prefetchEnabled !== false
  ns.speculativePrefetchEnabled = settings.speculativePrefetchEnabled !== false
  ns.serveFromCache = settings.serveFromCache !== false
  ns.speculativeAdaptiveMode =
    typeof settings.speculativeAdaptiveMode === "string"
      ? settings.speculativeAdaptiveMode
      : "full"
  const targetRunway = Number(settings.bufferTargetRunwaySec)
  ns.bufferTargetRunwaySec =
    Number.isFinite(targetRunway) && targetRunway > 0 ? targetRunway : 60
  ns.networkPanicActive = settings.networkPanicActive === true
  const netP95 = Number(settings.networkFirstByteP95Ms)
  ns.networkFirstByteP95Ms =
    Number.isFinite(netP95) && netP95 > 0 ? netP95 : 0
  if (ns.networkPanicActive) {
    ns.logBridge?.(
      `Network panic mode active — target buffer runway ${ns.bufferTargetRunwaySec}s`,
      "INFO"
    )
  }
  if (ns.extensionEnabled === false || ns.prefetchEnabled === false) {
    if (typeof cancelPrefetchRunway === "function") {
      cancelPrefetchRunway()
    }
  }
}

const knownSegments = new Set()

window.addEventListener("message", (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.__aegisstream !== true) return

  // Receive known segment URLs from background
  if (data.type === "CACHE_REGISTRY_SYNC" && data.payload) {
    if (typeof ns.activateMediaBridge === "function") {
      ns.activateMediaBridge("registry-sync")
    }
    if (typeof ns.applyCacheRegistrySync === "function") {
      ns.applyCacheRegistrySync(data.payload)
    }
    return
  }

  if (data.type === "RESET_SEEKING_STATE") {
    if (typeof ns.resetAllSeekingControllers === "function") {
      ns.resetAllSeekingControllers(data.anchorIndex)
    }
    if (data.reason === "variant-switch") {
      const graceUntil = Number(data.variantSwitchGraceUntil || 0)
      ns.variantSwitchGraceUntil =
        graceUntil > Date.now() ? graceUntil : Date.now() + 8_000
      if (typeof data.anchorIndex === "number") {
        ns.variantSwitchAnchorIndex = data.anchorIndex
      }
      ns.variantSwitchTeleportSuppressSec = 20
    }
    ns.logBridge?.(
      `Seeking/Kalman state reset (${data.reason || "manifest-reset"})`,
      "DEBUG"
    )
    return
  }

  if (data.type === "KNOWN_SEGMENTS" && data.urls) {
    if (typeof ns.activateMediaBridge === "function") {
      ns.activateMediaBridge("known-segments")
    }
    if (data.playbackHint && typeof data.playbackHint === "object") {
      ns.playbackManifestHint = {
        segmentDurations: Array.isArray(data.playbackHint.segmentDurations)
          ? data.playbackHint.segmentDurations
          : null,
        segmentCount: Number(data.playbackHint.segmentCount) || data.urls.length,
        totalDuration: Number.isFinite(Number(data.playbackHint.totalDuration))
          ? Number(data.playbackHint.totalDuration)
          : null
      }
    }
    if (data.resetSeeking === true && typeof ns.resetAllSeekingControllers === "function") {
      ns.resetAllSeekingControllers(data.anchorIndex)
    }
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

  if (data.type === "BUFFER_LOAD_PUSH") {
    if (typeof ns.pushBufferLoad === "function") {
      ns.pushBufferLoad({
        tier: data.tier,
        runwaySec: data.runwaySec,
        healthScore: data.healthScore,
        source: "background"
      })
    }
    return
  }

  // Handle prefetch commands from background (via content script)
  if (data.type === "PREFETCH_SEGMENTS" && data.urls) {
    if (ns.extensionEnabled === false || ns.prefetchEnabled === false) return
    if (typeof ns.activateMediaBridge === "function") {
      ns.activateMediaBridge("prefetch-segments")
    }
    if (typeof ns.notePrefetchIntentBatch === "function") {
      ns.notePrefetchIntentBatch(data.urls)
    }
    void prefetchSegmentsFromPage(data.urls, {
      networkGeneration: data.networkGeneration,
      playbackGeneration: data.playbackGeneration,
      priority: data.priority,
      reason: "prefetch-segments"
    })
    return
  }

  if (data.type === "CANCEL_PREFETCH") {
    if (typeof cancelPrefetchRunway === "function") {
      cancelPrefetchRunway(data.keepUrls || [], {
        networkGeneration: data.networkGeneration,
        reason: "cancel-prefetch"
      })
    } else if (typeof ns.cancelInflightChunkStores === "function") {
      ns.cancelInflightChunkStores("cancel-prefetch")
    }
    return
  }

  if (data.type === "SETTINGS_UPDATED" && data.settings) {
    applyRuntimeSettings(data.settings)
    if (typeof ns.flushPendingStoresAfterReconnect === "function") {
      void ns.flushPendingStoresAfterReconnect()
    }
    return
  }

  if (data.type === "EXTENSION_RECOVERED") {
    if (typeof ns.isMediaBridgeActive === "function" && !ns.isMediaBridgeActive()) {
      return
    }
    if (typeof ns.flushPendingStoresAfterReconnect === "function") {
      void ns.flushPendingStoresAfterReconnect()
    }
    if (typeof ns.requestBufferHealthTick === "function") {
      ns.requestBufferHealthTick(data.reason || "extension-recovered")
    }
    return
  }

  if (data.type === "REFRESH_PLAYLIST" && data.url) {
    if (typeof cancelPrefetchRunway === "function") {
      cancelPrefetchRunway([], { reason: "refresh-playlist" })
    } else if (typeof ns.cancelInflightChunkStores === "function") {
      ns.cancelInflightChunkStores("refresh-playlist")
    }
    void refreshPlaylistFromPage(data.url, data.generation)
    return
  }

  if (data.type === "EXTENSION_FETCH_CHUNK" && data.requestId) {
    if (typeof ns.onExtensionFetchChunk === "function") {
      ns.onExtensionFetchChunk(data.requestId, data.bytes ?? data.chunkBase64)
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

function onPageSessionTeardown() {
  if (typeof cancelPrefetchRunway === "function") {
    cancelPrefetchRunway([], { reason: "page-teardown" })
  } else if (typeof ns.cancelInflightChunkStores === "function") {
    ns.cancelInflightChunkStores("page-teardown")
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", onPageSessionTeardown)
}

ns.knownSegments = knownSegments
})()
