(() => {
  var ns = (self.AegisBackground ||= {})
  const { addLog, stripHash } = ns

  const inflightByKey = new Map()

  /**
   * One network fetch per tab+playlist URL. Duplicate callers await the same promise.
   */
  async function coalescedFetchPlaylistText(tabId, playlistUrl, options = {}) {
    const normalized =
      typeof stripHash === "function" ? stripHash(playlistUrl) : playlistUrl
    if (!normalized) return null

    const depth = Number(options.depth) || 0
    const lockKey = `${tabId}|${normalized}|${depth}`
    const existing = inflightByKey.get(lockKey)
    if (existing) {
      if (options.logCoalesce !== false) {
        addLog(
          "DEBUG",
          `Manifest fetch coalesced on tab ${tabId}: ${normalized.slice(-80)}`
        )
      }
      return existing
    }

    const fetchPromise = (async () => {
      const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 12_000)
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
      try {
        // This is the call that hotlink-protected hosts answer with 403: a
        // service-worker fetch carries no Referer, unlike the identical
        // request from the page. Referer cannot be set on the init object
        // (forbidden header name), so it is installed as a session DNR rule
        // scoped to extension-initiated requests before the fetch goes out.
        if (typeof ns.ensureMediaRefererRule === "function") {
          const refererUrl =
            typeof ns.getPlayerRefererUrl === "function" ? ns.getPlayerRefererUrl(tabId) : null
          if (refererUrl) await ns.ensureMediaRefererRule(normalized, refererUrl).catch(() => {})
        }
        const res = await fetch(normalized, {
          credentials: "include",
          cache: "no-store",
          ...(controller ? { signal: controller.signal } : {})
        })
        const contentType = (res.headers.get("content-type") || "").toLowerCase()
        const text = res.ok ? await res.text() : ""
        return {
          ok: res.ok,
          status: res.status,
          text,
          contentType,
          normalizedUrl: normalized
        }
      } catch (e) {
        return {
          ok: false,
          status: 0,
          text: "",
          contentType: "",
          normalizedUrl: normalized,
          error: e?.name === "AbortError" ? `fetch timeout after ${timeoutMs}ms` : e?.message || "fetch failed"
        }
      } finally {
        if (timer) clearTimeout(timer)
        inflightByKey.delete(lockKey)
      }
    })()

    inflightByKey.set(lockKey, fetchPromise)
    return fetchPromise
  }

  ns.cancelCoalescedFetchForTab = function cancelCoalescedFetchForTab(tabId) {
    if (!Number.isFinite(tabId)) return 0
    let cancelled = 0
    for (const key of [...inflightByKey.keys()]) {
      if (key.startsWith(`${tabId}|`)) {
        inflightByKey.delete(key)
        cancelled += 1
      }
    }
    return cancelled
  }

  ns.coalescedFetchPlaylistText = coalescedFetchPlaylistText
})()
