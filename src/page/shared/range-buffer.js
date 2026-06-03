// ---------------------------------------------------------------------------
// AegisStream Range Buffer (YouTube / MSE Support)
// ---------------------------------------------------------------------------

(() => {
  const bridge = self.AegisPageBridge
  if (bridge?.claimExecutionSlot && !bridge.claimExecutionSlot("range-buffer")) return
  if (window.AegisRangeBuffer) return

  const originalFetch = window.fetch.bind(window)
  const activePrefetches = new Set()
  const MAX_HEURISTIC_PREFETCHES = 2

  function getHeaderValue(headers, targetName) {
    if (!headers || typeof headers !== "object") return null
    const normalizedTarget = String(targetName || "").toLowerCase()
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() === normalizedTarget) {
        return typeof value === "string" ? value : null
      }
    }
    return null
  }

  async function fetchWithExtensionFallback(url, requestRuntime) {
    const bufferedFetch = self.AegisPageBridge?.requestExtensionFetchBuffered
    const extensionRes = bufferedFetch
      ? await bufferedFetch({ url, method: "GET", headers: {} })
      : await requestRuntime("EXTENSION_FETCH_REQUEST", {
          url,
          method: "GET",
          headers: {}
        })
    if (!extensionRes?.ok) {
      return {
        ok: false,
        error: extensionRes?.error
          ? `extension fetch failed: ${extensionRes.error}`
          : "extension fetch failed",
        transient: true
      }
    }

    const statusCode = Number(extensionRes.statusCode || 0)
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      return {
        ok: false,
        error: `extension HTTP ${statusCode || "unknown"}`,
        transient: statusCode >= 500 || statusCode === 0
      }
    }

    const bytes =
      extensionRes.bytes && typeof extensionRes.bytes.byteLength === "number"
        ? extensionRes.bytes
        : Array.isArray(extensionRes.bytes)
          ? Uint8Array.from(extensionRes.bytes).buffer
          : null
    if (!bytes || bytes.byteLength === 0) {
      return {
        ok: false,
        error: "extension empty response",
        transient: true
      }
    }

    return {
      ok: true,
      bytes,
      contentType:
        getHeaderValue(extensionRes.headers, "content-type") || "application/octet-stream",
      statusCode
    }
  }

  function stripPathToken(pathname, token) {
    const regex = new RegExp(`/${token}/[^/]+`, "gi")
    return pathname.replace(regex, "")
  }

  class RangeBuffer {
    parseRange(url, headers) {
      let start = null
      let end = null

      let type = "bytes"

      // Check headers
      const rangeHeader = headers?.get("range")
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/)
        if (match) {
          start = parseInt(match[1], 10)
          end = match[2] ? parseInt(match[2], 10) : null
        }
      }

      // Check URL params
      if (start === null) {
        try {
          const urlObj = new URL(url, location.href)
          const rangeParam = urlObj.searchParams.get("range")
          if (rangeParam) {
            const match = rangeParam.match(/(\d+)-(\d+)?/)
            if (match) {
              start = parseInt(match[1], 10)
              end = match[2] ? parseInt(match[2], 10) : null
            }
          }

          if (start === null) {
            const rbufParam = urlObj.searchParams.get("rbuf")
            if (rbufParam) {
              const match = rbufParam.match(/(\d+)-(\d+)?/)
              if (match) {
                start = parseInt(match[1], 10)
                end = match[2] ? parseInt(match[2], 10) : null
              }
            }
          }

          if (start === null && urlObj.searchParams.has("sq")) {
            const sq = parseInt(urlObj.searchParams.get("sq"), 10)
            if (Number.isFinite(sq)) {
              start = sq
              end = null
              type = "sq"
            }
          }

          if (start === null) {
            const pathRangeMatch = urlObj.pathname.match(/\/range\/(\d+)-(\d+)/i)
            if (pathRangeMatch) {
              start = parseInt(pathRangeMatch[1], 10)
              end = parseInt(pathRangeMatch[2], 10)
              type = "bytes"
            }
          }

          if (start === null) {
            const pathSqMatch = urlObj.pathname.match(/\/sq\/(\d+)/i)
            if (pathSqMatch) {
              const sq = parseInt(pathSqMatch[1], 10)
              if (Number.isFinite(sq)) {
                start = sq
                end = null
                type = "sq"
              }
            }
          }
        } catch { /* ignore */ }
      }

      if (!Number.isFinite(start)) {
        start = null
      }
      if (!Number.isFinite(end)) {
        end = null
      }

      return { start, end, type }
    }

    parseContentRangeHeader(contentRangeHeader) {
      if (typeof contentRangeHeader !== "string" || !contentRangeHeader) return null
      const match = contentRangeHeader.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i)
      if (!match) return null
      const start = parseInt(match[1], 10)
      const end = parseInt(match[2], 10)
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      return { start, end }
    }

    getStreamId(url) {
      const stableIdentity = self.AegisPageBridge?.getYoutubePlaybackIdentity?.(url)
      if (stableIdentity) {
        return `yt|${stableIdentity}`
      }

      try {
        const u = new URL(url, location.href)
        u.searchParams.delete("range")
        u.searchParams.delete("rn") // request number
        u.searchParams.delete("rbuf")
        u.searchParams.delete("sq")
        // Also remove 'alr' which changes occasionally on youtube
        u.searchParams.delete("alr")

        if (/\bgooglevideo\.com$/i.test(u.hostname) && /\/videoplayback/i.test(u.pathname)) {
          u.pathname = stripPathToken(stripPathToken(u.pathname, "range"), "sq")
          u.pathname = stripPathToken(u.pathname, "rn")
        }
        return u.toString().split("#")[0]
      } catch {
        return url.split("#")[0]
      }
    }

    formatCacheKey(streamId, start, end) {
      return `range|${streamId}|${start}-${end !== null ? end : ""}`
    }

    buildNextRangeUrl(originalUrl, currentStart, currentEnd, type = "bytes") {
      try {
        const u = new URL(originalUrl, location.href)
        
        if (type === "sq") {
          const nextSq = currentStart + 1
          if (/\/sq\/\d+/i.test(u.pathname)) {
            u.pathname = u.pathname.replace(/\/sq\/\d+/i, `/sq/${nextSq}`)
          } else {
            u.searchParams.set("sq", nextSq)
          }
        } else {
          if (currentEnd === null) return null
          const size = currentEnd - currentStart + 1
          if (size <= 0 || size > 10_000_000) return null

          const nextStart = currentEnd + 1
          const nextEnd = nextStart + size - 1

          if (u.searchParams.has("range")) {
            u.searchParams.set("range", `${nextStart}-${nextEnd}`)
          } else if (u.searchParams.has("rbuf")) {
            u.searchParams.set("rbuf", `${nextStart}-${nextEnd}`)
          } else if (/\/range\/\d+-\d+/i.test(u.pathname)) {
            u.pathname = u.pathname.replace(/\/range\/\d+-\d+/i, `/range/${nextStart}-${nextEnd}`)
          } else {
            return null
          }
        }
        
        // Increment request number if present to avoid 400 Bad Request
        if (u.searchParams.has("rn")) {
          const rn = parseInt(u.searchParams.get("rn"), 10)
          if (!isNaN(rn)) u.searchParams.set("rn", rn + 1)
        }
        
        return u.toString()
      } catch {
        return null
      }
    }

    // Triggered by page-bridge when a network response finishes
    triggerHeuristicPrefetch(originalUrl, headers, notifyRuntime, requestRuntime) {
      if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) {
        return
      }
      const tier = self.AegisPageBridge?.bufferTier
      if (tier === "idle") {
        return
      }

      const { start, end, type } = this.parseRange(originalUrl, headers)
      if (!Number.isFinite(start) || (end === null && type !== "sq")) return

      const nextUrl = this.buildNextRangeUrl(originalUrl, start, end, type)
      if (!nextUrl || activePrefetches.has(nextUrl)) return
      if (activePrefetches.size >= MAX_HEURISTIC_PREFETCHES) return
      
      activePrefetches.add(nextUrl)

      ;(async () => {
        try {
          // Determine cache key for the PREFETCHED chunk
          const streamId = this.getStreamId(nextUrl)
          const nextRange = this.parseRange(nextUrl, new Headers())
          if (!Number.isFinite(nextRange.start)) {
            return
          }
          const cacheKey = this.formatCacheKey(streamId, nextRange.start, nextRange.end)

          // Fetch proactively, with service-worker extension fetch for CORS/signed URLs.
          let bytes = null
          let contentType = "application/octet-stream"
          let requestStatus = 0

          let res = await originalFetch(nextUrl, { cache: "no-store" })
          if (res.status === 403 || res.status === 401) {
            res = await originalFetch(nextUrl, { credentials: "include", cache: "no-store" })
          }

          requestStatus = Number(res.status || 0)
          if (res.ok) {
            bytes = await res.arrayBuffer()
            contentType = res.headers.get("content-type") || "application/octet-stream"
          } else {
            const extensionFallback = await fetchWithExtensionFallback(nextUrl, requestRuntime)
            if (!extensionFallback.ok) {
              const transient =
                extensionFallback.transient === true ||
                requestStatus === 0 ||
                requestStatus === 408 ||
                requestStatus === 425 ||
                requestStatus === 429 ||
                requestStatus >= 500
              notifyRuntime("PREFETCH_RESULT", {
                url: nextUrl,
                success: false,
                error:
                  requestStatus > 0
                    ? `HTTP ${requestStatus}; ${extensionFallback.error}`
                    : extensionFallback.error,
                transient
              })
              return
            }
            bytes = extensionFallback.bytes
            contentType = extensionFallback.contentType
          }

          if (!bytes || bytes.byteLength === 0) return

          // Send to background for caching using the normalized cache key
          const storeRes = await requestRuntime("STORE_CHUNK_REQUEST", {
            url: cacheKey,
            contentType,
            bytes,
            status: 200, // Treat as full so background caches it
            method: "GET",
            hasRange: false
          })

          if (!storeRes?.ok) {
            notifyRuntime("PREFETCH_RESULT", {
              url: nextUrl,
              success: false,
              error: storeRes?.error ? `store failed: ${storeRes.error}` : "store failed"
            })
            return
          }

          notifyRuntime("PREFETCH_RESULT", { url: nextUrl, success: true, size: bytes.byteLength })
        } catch (e) {
          const message = e?.message || "unknown"
          const transient = /failed to fetch|aborted|aborterror|networkerror|load failed/i.test(
            String(message).toLowerCase()
          )
          notifyRuntime("PREFETCH_RESULT", {
            url: nextUrl,
            success: false,
            error: message,
            transient
          })
        } finally {
          activePrefetches.delete(nextUrl)
        }
      })()
    }
  }

  window.AegisRangeBuffer = new RangeBuffer()
})()
