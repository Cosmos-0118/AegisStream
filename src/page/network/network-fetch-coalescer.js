/**
 * Cross-context network collapse: one in-flight fetch per cache/coalesce key on the page.
 */
(() => {
  const ns = (globalThis.AegisPageBridge ||= {})

  const inflightByKey = new Map()
  const COALESCE_TTL_MS = 12_000
  const COLLAPSE_WAIT_MIN_MS = 1_500
  const COLLAPSE_WAIT_MAX_MS = 8_000
  const COLLAPSE_WAIT_P95_MULTIPLIER = 2

  function resolveCollapseWaitTimeoutMs(overrideMs) {
    if (Number.isFinite(overrideMs) && overrideMs > 0) {
      return Math.max(COLLAPSE_WAIT_MIN_MS, Math.min(COLLAPSE_WAIT_MAX_MS, overrideMs))
    }
    const p95 = Number(ns.networkFirstByteP95Ms)
    const derived =
      Number.isFinite(p95) && p95 > 0
        ? Math.round(p95 * COLLAPSE_WAIT_P95_MULTIPLIER)
        : COLLAPSE_WAIT_MAX_MS
    return Math.max(COLLAPSE_WAIT_MIN_MS, Math.min(COLLAPSE_WAIT_MAX_MS, derived))
  }

  function isCanonicalCoalesceKey(value) {
    return typeof value === "string" && /^(?:range|aegis|ump)\|/.test(value)
  }

  /**
   * Match cache/store identity — not raw signed URLs (token=A vs token=B).
   */
  function resolveNetworkCoalesceKey(pageUrl, cacheKey) {
    if (isCanonicalCoalesceKey(cacheKey)) return cacheKey
    if (isCanonicalCoalesceKey(pageUrl)) return pageUrl

    if (cacheKey && typeof ns.buildMediaInvariantKey === "function") {
      const fromCacheKey = ns.buildMediaInvariantKey(cacheKey)
      if (fromCacheKey) return fromCacheKey
    }

    if (pageUrl && typeof ns.buildYoutubeChunkState === "function") {
      try {
        const youtubeChunk = ns.buildYoutubeChunkState(pageUrl, new Headers())
        if (youtubeChunk?.cacheKey) return youtubeChunk.cacheKey
      } catch {
        // ignore parse failures
      }
    }

    if (pageUrl && typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(pageUrl)
      if (invariant) return invariant
    }

    const fallback = pageUrl || cacheKey
    return typeof ns.stripHash === "function" ? ns.stripHash(fallback) : fallback
  }

  function resolvePrefetchCoalesceKey(pageUrl) {
    return resolveNetworkCoalesceKey(pageUrl, null)
  }

  function purgeStaleCoalescedEntries(now = Date.now()) {
    for (const [key, entry] of inflightByKey.entries()) {
      if (now - Number(entry.startedAt || 0) > COALESCE_TTL_MS) {
        inflightByKey.delete(key)
      }
    }
  }

  function isNetworkFetchInflight(pageUrl, cacheKey) {
    purgeStaleCoalescedEntries()
    const key = resolveNetworkCoalesceKey(pageUrl, cacheKey)
    return key ? inflightByKey.has(key) : false
  }

  /**
   * Run factory once per key; concurrent callers share the same promise.
   */
  function beginCoalescedNetworkFetch(key, factory) {
    if (!key || typeof factory !== "function") {
      return factory ? factory() : Promise.resolve({ ok: false, error: "missing-key" })
    }
    purgeStaleCoalescedEntries()
    const existing = inflightByKey.get(key)
    if (existing) return existing.promise

    let settle
    const promise = new Promise((resolve) => {
      settle = resolve
    })
    const entry = { promise, startedAt: Date.now() }
    inflightByKey.set(key, entry)

    ;(async () => {
      try {
        const result = await factory()
        settle(result || { ok: false, error: "empty-result" })
      } catch (error) {
        settle({
          ok: false,
          error: error?.message || String(error || "coalesced-fetch-failed")
        })
      } finally {
        if (inflightByKey.get(key) === entry) {
          inflightByKey.delete(key)
        }
      }
    })()

    return promise
  }

  async function joinCoalescedNetworkFetch(pageUrl, cacheKey, options = {}) {
    purgeStaleCoalescedEntries()
    const key = resolveNetworkCoalesceKey(pageUrl, cacheKey)
    if (!key) return null
    const entry = inflightByKey.get(key)
    if (!entry) return null

    const timeoutMs = resolveCollapseWaitTimeoutMs(options.timeoutMs)
    let timerId = null
    try {
      return await Promise.race([
        entry.promise,
        new Promise((resolve) => {
          timerId = setTimeout(() => resolve(null), timeoutMs)
        })
      ])
    } finally {
      if (timerId != null) clearTimeout(timerId)
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Player lane: join an active page prefetch and/or wait for background-scheduled work
   * to land in cache before opening a duplicate network socket.
   */
  async function awaitCollapsedNetworkDelivery(pageUrl, cacheKey, lookupCached, options = {}) {
    const timeoutMs = resolveCollapseWaitTimeoutMs(options.timeoutMs)
    const pollMs = Math.max(40, Number(options.pollMs) || 60)
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - started)
      if (isNetworkFetchInflight(pageUrl, cacheKey)) {
        const joined = await joinCoalescedNetworkFetch(pageUrl, cacheKey, {
          timeoutMs: Math.min(remaining, pollMs + 40)
        })
        if (joined?.ok && joined.bytes) {
          return joined
        }
      }

      if (typeof lookupCached === "function") {
        const cached = await lookupCached()
        if (cached?.ok && cached.bytes) {
          return {
            ok: true,
            bytes: cached.bytes,
            contentType: cached.contentType,
            status: cached.status,
            fromCache: true
          }
        }
      }

      if (typeof ns.requestRuntime === "function") {
        const queryKey = resolveNetworkCoalesceKey(pageUrl, cacheKey)
        const query = await ns.requestRuntime("INFLIGHT_PREFETCH_QUERY", {
          url: queryKey || cacheKey || pageUrl
        })
        if (query?.inflight !== true) {
          break
        }
      } else {
        break
      }

      await sleep(pollMs)
    }

    return null
  }

  ns.isCanonicalCoalesceKey = isCanonicalCoalesceKey
  ns.resolveNetworkCoalesceKey = resolveNetworkCoalesceKey
  ns.resolvePrefetchCoalesceKey = resolvePrefetchCoalesceKey
  ns.isNetworkFetchInflight = isNetworkFetchInflight
  ns.beginCoalescedNetworkFetch = beginCoalescedNetworkFetch
  ns.joinCoalescedNetworkFetch = joinCoalescedNetworkFetch
  ns.awaitCollapsedNetworkDelivery = awaitCollapsedNetworkDelivery
  ns.resolveCollapseWaitTimeoutMs = resolveCollapseWaitTimeoutMs
})()
