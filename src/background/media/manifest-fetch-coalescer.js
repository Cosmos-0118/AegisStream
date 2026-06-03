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
      try {
        const res = await fetch(normalized, {
          credentials: "include",
          cache: "no-store"
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
          error: e?.message || "fetch failed"
        }
      } finally {
        inflightByKey.delete(lockKey)
      }
    })()

    inflightByKey.set(lockKey, fetchPromise)
    return fetchPromise
  }

  ns.coalescedFetchPlaylistText = coalescedFetchPlaylistText
})()
