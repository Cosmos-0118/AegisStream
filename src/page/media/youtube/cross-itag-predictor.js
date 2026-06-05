(() => {
  const bridge = self.AegisPageBridge
  if (bridge?.claimExecutionSlot && !bridge.claimExecutionSlot("youtube-cross-itag")) return
  if (globalThis.AegisYoutubeCrossItag) return

  const templatesByItag = new Map()
  const activePrefetches = new Set()
  const MAX_CROSS_ITAG_PREFETCHES = 2
  const MIN_RUNWAY_SEC = 15

  function isYoutubePlayback(url) {
    return typeof url === "string" && /\bgooglevideo\.com\/videoplayback\b/i.test(url)
  }

  function getRunwaySec() {
    const runway = Number(bridge?.bufferRunwaySec)
    if (Number.isFinite(runway) && runway >= 0) return runway
    const video = document.querySelector("video")
    if (!(video instanceof HTMLMediaElement) || !Number.isFinite(video.currentTime)) return 0
    for (let i = 0; i < video.buffered.length; i += 1) {
      const start = video.buffered.start(i)
      const end = video.buffered.end(i)
      if (video.currentTime >= start && video.currentTime <= end) {
        return Math.max(0, end - video.currentTime)
      }
    }
    return 0
  }

  function shouldSpeculate() {
    if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) return false
    if (bridge?.extensionEnabled === false || bridge?.prefetchEnabled === false) return false
    if (bridge?.speculativePrefetchEnabled === false) return false
    if (bridge?.crossItagAllowed !== true) return false
    const graceUntil = Number(bridge?.variantSwitchGraceUntil || 0)
    if (graceUntil > Date.now()) return false
    const tier = bridge?.bufferTier
    if (tier === "emergency" || tier === "aggressive") return false
    return getRunwaySec() >= MIN_RUNWAY_SEC
  }

  function recordTemplate(url) {
    if (!isYoutubePlayback(url)) return
    try {
      const parsed = new URL(url, location.href)
      const itag = parsed.searchParams.get("itag")
      const id = parsed.searchParams.get("id")
      if (!itag) return
      templatesByItag.set(itag, {
        itag,
        videoId: id,
        templateUrl: parsed.toString(),
        updatedAt: Date.now()
      })
      while (templatesByItag.size > 12) {
        const oldest = [...templatesByItag.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]
        if (oldest) templatesByItag.delete(oldest[0])
      }
    } catch {
      // ignore
    }
  }

  function cloneUrlForItag(sourceUrl, targetItag, sequenceIndex, rangeType) {
    try {
      const out = new URL(sourceUrl, location.href)
      out.searchParams.set("itag", targetItag)
      if (rangeType === "sq" && Number.isFinite(sequenceIndex)) {
        out.searchParams.set("sq", String(sequenceIndex))
        out.searchParams.delete("range")
        out.searchParams.delete("rbuf")
      } else if (rangeType === "bytes") {
        // Keep range/rbuf from the active stream; byte offsets are itag-specific but
        // cloning signed params still helps warm the cache for overlapping requests.
      }
      if (out.searchParams.has("rn")) {
        const rn = parseInt(out.searchParams.get("rn"), 10)
        if (Number.isFinite(rn)) out.searchParams.set("rn", String(rn + 1))
      }
      return out.toString()
    } catch {
      return null
    }
  }

  async function prefetchCrossItagUrl(targetUrl, notifyRuntime, requestRuntime, meta = {}) {
    if (!targetUrl || activePrefetches.has(targetUrl)) return
    if (activePrefetches.size >= MAX_CROSS_ITAG_PREFETCHES) return
    activePrefetches.add(targetUrl)

    const originalFetch = window.fetch.bind(window)
    const RangeBuffer = window.AegisRangeBuffer

    try {
      let res = await originalFetch(targetUrl, { cache: "no-store" })
      if (res.status === 403 || res.status === 401) {
        res = await originalFetch(targetUrl, { credentials: "include", cache: "no-store" })
      }
      let bytes = null
      let contentType = "application/octet-stream"
      if (res.ok) {
        bytes = await res.arrayBuffer()
        contentType = res.headers.get("content-type") || contentType
      } else if (typeof bridge?.requestExtensionFetchBuffered === "function") {
        const extensionRes = await bridge.requestExtensionFetchBuffered({
          url: targetUrl,
          method: "GET",
          headers: {},
          source: "cross-itag"
        })
        if (extensionRes?.ok && extensionRes.bytes) {
          bytes =
            extensionRes.bytes?.byteLength != null
              ? extensionRes.bytes
              : Uint8Array.from(extensionRes.bytes).buffer
          contentType =
            extensionRes.headers?.["content-type"] || extensionRes.contentType || contentType
        }
      }

      if (!bytes || bytes.byteLength === 0) return

      const chunkState =
        typeof bridge?.buildYoutubeChunkState === "function"
          ? bridge.buildYoutubeChunkState(targetUrl, new Headers())
          : RangeBuffer
            ? (() => {
                const parsed = RangeBuffer.parseRange(targetUrl, new Headers())
                if (!Number.isFinite(parsed.start)) return null
                const streamId = RangeBuffer.getStreamId(targetUrl)
                return {
                  cacheKey: RangeBuffer.formatCacheKey(streamId, parsed.start, parsed.end)
                }
              })()
            : null

      const storeUrl = chunkState?.cacheKey || targetUrl
      notifyRuntime("SPECULATIVE_REGISTER", {
        url: storeUrl,
        source: "cross-itag",
        fromItag: meta.fromItag || null,
        toItag: meta.toItag || null
      })
      const storeChunk =
        typeof bridge?.storeChunkFromPage === "function"
          ? bridge.storeChunkFromPage
          : (payload) => requestRuntime("STORE_CHUNK_REQUEST", payload)

      const bytesForStore =
        typeof bridge?.copyArrayBufferForBridge === "function"
          ? bridge.copyArrayBufferForBridge(bytes)
          : bytes
      if (!bytesForStore || bytesForStore.byteLength === 0) {
        notifyRuntime("PREFETCH_RESULT", {
          url: storeUrl,
          success: false,
          error: "invalid-bytes-for-store",
          source: "cross-itag"
        })
        return
      }

      const storeRes = await storeChunk({
        url: storeUrl,
        contentType,
        bytes: bytesForStore,
        status: 200,
        method: "GET",
        hasRange: false,
        captureSource: "cross-itag"
      })

      if (storeRes?.ok) {
        notifyRuntime("PREFETCH_RESULT", {
          url: storeUrl,
          success: true,
          size: bytes.byteLength,
          source: "cross-itag"
        })
        if (typeof bridge?.reportRuntimeMetric === "function") {
          bridge.reportRuntimeMetric("youtube_cross_itag_prefetch", { itag: new URL(targetUrl).searchParams.get("itag") })
        }
      }
    } catch {
      // best-effort speculative path
    } finally {
      activePrefetches.delete(targetUrl)
    }
  }

  function maybeSpeculateFromPlayback(sourceUrl, chunkMeta = {}) {
    if (!shouldSpeculate()) return
    recordTemplate(sourceUrl)

    const sourceItag = (() => {
      try {
        return new URL(sourceUrl, location.href).searchParams.get("itag")
      } catch {
        return null
      }
    })()
    if (!sourceItag) return

    const rangeType = chunkMeta.type || "bytes"
    const sequenceIndex = Number.isFinite(chunkMeta.start) ? chunkMeta.start : null
    if (rangeType !== "sq" && rangeType !== "bytes") return

    const notifyRuntime =
      typeof bridge?.notifyRuntime === "function" ? bridge.notifyRuntime.bind(bridge) : () => {}
    const requestRuntime =
      typeof bridge?.requestRuntime === "function" ? bridge.requestRuntime.bind(bridge) : () => {}

    for (const [itag] of templatesByItag) {
      if (itag === sourceItag) continue
      const predicted = cloneUrlForItag(sourceUrl, itag, sequenceIndex, rangeType)
      if (!predicted) continue
      void prefetchCrossItagUrl(predicted, notifyRuntime, requestRuntime, {
        fromItag: sourceItag,
        toItag: itag
      })
    }
  }

  globalThis.AegisYoutubeCrossItag = {
    recordTemplate,
    maybeSpeculateFromPlayback,
    getObservedItags: () => [...templatesByItag.keys()]
  }
})()
