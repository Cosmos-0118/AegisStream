/**
 * Cross-context network collapse: one in-flight fetch per cache/coalesce key on the page.
 */
(() => {
  const ns = (globalThis.AegisPageBridge ||= {})

  const inflightByKey = new Map()
  /** @type {Map<string, string>} coalesce key -> representative page URL for abort protection */
  const coalesceKeyToUrl = new Map()
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
    return typeof value === "string" && /^(?:range|aegis)\|/.test(value)
  }

  const MEDIA_SEGMENT_PATH_RE =
    /\.(ts|m4s|mp4|cmf|webm|aac|m4a|m4v|fmp4|cmfv|cmfa|cmft)($|[/?#])/i
  /** Packagers that encode parallel renditions in query instead of path. */
  const STREAM_SELECTOR_PARAMS = ["track", "quality", "stream", "variant", "bitrate"]

  function appendWhitelistedStreamSelector(hostnamePathname, searchParams) {
    for (const selector of STREAM_SELECTOR_PARAMS) {
      if (searchParams.has(selector)) {
        const value = searchParams.get(selector)
        if (value != null && value !== "") {
          return `${hostnamePathname}?${selector}=${value}`
        }
      }
    }
    return hostnamePathname
  }

  /**
   * Collision-resistant HLS/DASH key: host + full pathname (variant directories preserved).
   * Volatile auth tokens are stripped; whitelisted stream selectors (?track=audio) are kept.
   */
  function resolveStructuralPathCoalesceKey(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return null
    try {
      let parsed
      try {
        parsed = new URL(rawUrl)
      } catch {
        const base =
          typeof location !== "undefined" && location.href ? location.href : "https://localhost/"
        parsed = new URL(rawUrl, base)
      }
      if (!/^https?:$/i.test(parsed.protocol)) return null
      const pathname = parsed.pathname || ""
      if (!pathname || pathname === "/") return null
      if (!MEDIA_SEGMENT_PATH_RE.test(pathname)) return null
      const hostnamePath = `${parsed.hostname.toLowerCase()}${pathname}`.toLowerCase()
      return appendWhitelistedStreamSelector(hostnamePath, parsed.searchParams).toLowerCase()
    } catch {
      const clean = rawUrl.split(/[?#]/)[0]
      return clean ? clean.toLowerCase().trim() : null
    }
  }

  function isObfuscatedBlobInvariant(invariant) {
    return (
      typeof invariant === "string" &&
      (invariant.startsWith("aegis|blob|") || invariant.startsWith("aegis|fallback|"))
    )
  }

  /**
   * Match cache/store identity — not raw signed URLs (token=A vs token=B).
   * False positives are catastrophic: never collapse unlike variants/tracks/ranges.
   */
  function resolveNetworkCoalesceKey(pageUrl, cacheKey) {
    if (isCanonicalCoalesceKey(cacheKey)) return cacheKey
    if (isCanonicalCoalesceKey(pageUrl)) return pageUrl

    const primaryUrl = pageUrl || cacheKey

    if (primaryUrl && typeof ns.buildMediaInvariantKey === "function") {
      const blobInvariant = ns.buildMediaInvariantKey(primaryUrl)
      if (isObfuscatedBlobInvariant(blobInvariant)) return blobInvariant
    }

    const structural = resolveStructuralPathCoalesceKey(primaryUrl)
    if (structural) return structural

    if (primaryUrl && typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(primaryUrl)
      if (invariant) return invariant
    }

    // Token-churn shield: never fall back to stripHash(url) — that retains ?token= rotators.
    try {
      let parsed
      try {
        parsed = new URL(primaryUrl)
      } catch {
        const base =
          typeof location !== "undefined" && location.href ? location.href : "https://localhost/"
        parsed = new URL(primaryUrl, base)
      }
      if (/^https?:$/i.test(parsed.protocol)) {
        const hostnamePath = `${parsed.hostname.toLowerCase()}${parsed.pathname || ""}`.toLowerCase()
        if (hostnamePath && hostnamePath !== parsed.hostname.toLowerCase()) {
          return appendWhitelistedStreamSelector(hostnamePath, parsed.searchParams).toLowerCase()
        }
      }
    } catch {
      // fall through
    }

    const queryStripped = String(primaryUrl).split(/[?#]/)[0]
    return queryStripped ? queryStripped.toLowerCase().trim() : primaryUrl
  }

  function resolvePrefetchCoalesceKey(pageUrl) {
    return resolveNetworkCoalesceKey(pageUrl, null)
  }

  /** Canonical registry key — same namespace as cache-registry intent/wire maps. */
  function resolvePageRegistryKey(pageUrl, cacheKey) {
    return resolveNetworkCoalesceKey(pageUrl, cacheKey)
  }

  function hasActivePageWire(pageUrl, cacheKey) {
    purgeStaleCoalescedEntries()
    const key = resolveNetworkCoalesceKey(pageUrl, cacheKey)
    return Boolean(key && inflightByKey.has(key))
  }

  /**
   * Layer 4 local collapse: join the page-heap coalesced fetch with zero IPC.
   */
  async function joinActivePageWire(pageUrl, cacheKey, options = {}) {
    if (!hasActivePageWire(pageUrl, cacheKey)) {
      return { ok: false, reason: "no-active-wire" }
    }
    const timeoutMs = resolveCollapseWaitTimeoutMs(options.timeoutMs)
    try {
      const joined = await joinCoalescedNetworkFetch(pageUrl, cacheKey, { timeoutMs })
      if (joined?.ok && joined.bytes) {
        return {
          ok: true,
          bytes: joined.bytes,
          contentType: joined.contentType || "application/octet-stream",
          fromCache: joined.fromCache === true,
          via: "page-wire"
        }
      }
      if (joined === null) {
        return { ok: false, cancelled: true, reason: "wire-timeout" }
      }
      if (joined?.error && /abort/i.test(String(joined.error))) {
        return { ok: false, aborted: true, reason: joined.error }
      }
      return { ok: false, reason: joined?.error || "wire-empty" }
    } catch (error) {
      const aborted = error?.name === "AbortError" || /abort/i.test(String(error?.message || ""))
      return {
        ok: false,
        aborted,
        reason: error?.message || String(error || "wire-failed")
      }
    }
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
  function getCoalesceEntry(pageUrl, cacheKey) {
    purgeStaleCoalescedEntries()
    const key = resolveNetworkCoalesceKey(pageUrl, cacheKey)
    return key ? inflightByKey.get(key) || null : null
  }

  function getCoalesceConsumerCount(pageUrl, cacheKey) {
    const entry = getCoalesceEntry(pageUrl, cacheKey)
    return entry ? Number(entry.consumers) || 0 : 0
  }

  function isCoalesceAbortLocked(pageUrl, cacheKey) {
    return getCoalesceConsumerCount(pageUrl, cacheKey) > 0
  }

  function attachCoalesceConsumer(pageUrl, cacheKey) {
    const key = resolveNetworkCoalesceKey(pageUrl, cacheKey)
    if (!key) return 0
    const entry = inflightByKey.get(key)
    if (!entry) return 0
    entry.consumers = (Number(entry.consumers) || 0) + 1
    return entry.consumers
  }

  function releaseCoalesceConsumer(pageUrl, cacheKey) {
    const key = resolveNetworkCoalesceKey(pageUrl, cacheKey)
    if (!key) return 0
    const entry = inflightByKey.get(key)
    if (!entry) return 0
    entry.consumers = Math.max(0, (Number(entry.consumers) || 0) - 1)
    if (entry.consumers === 0 && entry.pendingRelease === true) {
      inflightByKey.delete(key)
      coalesceKeyToUrl.delete(key)
    }
    return entry.consumers
  }

  function collectCoalesceProtectedUrls() {
    const protectedUrls = new Set()
    for (const [key, entry] of inflightByKey.entries()) {
      if ((Number(entry.consumers) || 0) <= 0) continue
      const url = coalesceKeyToUrl.get(key)
      if (url) protectedUrls.add(url)
    }
    return Array.from(protectedUrls)
  }

  function beginCoalescedNetworkFetch(key, factory, representativeUrl = null) {
    if (!key || typeof factory !== "function") {
      return factory ? factory() : Promise.resolve({ ok: false, error: "missing-key" })
    }
    purgeStaleCoalescedEntries()
    const existing = inflightByKey.get(key)
    if (existing) {
      if (representativeUrl && !coalesceKeyToUrl.has(key)) {
        coalesceKeyToUrl.set(key, representativeUrl)
      }
      return existing.promise
    }

    let settle
    const promise = new Promise((resolve) => {
      settle = resolve
    })
    const entry = { promise, startedAt: Date.now(), consumers: 0 }
    inflightByKey.set(key, entry)
    if (representativeUrl) coalesceKeyToUrl.set(key, representativeUrl)

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
          if ((Number(entry.consumers) || 0) > 0) {
            entry.pendingRelease = true
          } else {
            inflightByKey.delete(key)
            coalesceKeyToUrl.delete(key)
          }
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
  function notifyInflightConsumerMutate(url, delta) {
    if (typeof ns.notifyRuntime !== "function" || !url) return
    ns.notifyRuntime("INFLIGHT_CONSUMER_MUTATE", { url, delta })
  }

  async function awaitCollapsedNetworkDelivery(pageUrl, cacheKey, lookupCached, options = {}) {
    const timeoutMs = resolveCollapseWaitTimeoutMs(options.timeoutMs)
    const pollMs = Math.max(40, Number(options.pollMs) || 60)
    const started = Date.now()
    attachCoalesceConsumer(pageUrl, cacheKey)
    notifyInflightConsumerMutate(cacheKey || pageUrl, 1)

    try {
      return await awaitCollapsedNetworkDeliveryInner(
        pageUrl,
        cacheKey,
        lookupCached,
        { timeoutMs, pollMs, started }
      )
    } finally {
      releaseCoalesceConsumer(pageUrl, cacheKey)
      notifyInflightConsumerMutate(cacheKey || pageUrl, -1)
    }
  }

  async function awaitCollapsedNetworkDeliveryInner(
    pageUrl,
    cacheKey,
    lookupCached,
    options = {}
  ) {
    const timeoutMs = Number(options.timeoutMs) || resolveCollapseWaitTimeoutMs()

    const localWire = await joinActivePageWire(pageUrl, cacheKey, { timeoutMs })
    if (localWire?.ok && localWire.bytes) {
      return localWire
    }

    if (typeof lookupCached === "function") {
      const cached = await lookupCached()
      if (cached?.ok && cached.bytes) {
        return {
          ok: true,
          bytes: cached.bytes,
          contentType: cached.contentType,
          status: cached.status,
          fromCache: true,
          via: cached.fromCache ? "cache" : "background-wire"
        }
      }
    }

    return null
  }

  ns.getCoalesceConsumerCount = getCoalesceConsumerCount
  ns.isCoalesceAbortLocked = isCoalesceAbortLocked
  ns.attachCoalesceConsumer = attachCoalesceConsumer
  ns.releaseCoalesceConsumer = releaseCoalesceConsumer
  ns.collectCoalesceProtectedUrls = collectCoalesceProtectedUrls
  ns.isCanonicalCoalesceKey = isCanonicalCoalesceKey
  ns.resolveStructuralPathCoalesceKey = resolveStructuralPathCoalesceKey
  ns.resolveNetworkCoalesceKey = resolveNetworkCoalesceKey
  ns.resolvePrefetchCoalesceKey = resolvePrefetchCoalesceKey
  ns.isNetworkFetchInflight = isNetworkFetchInflight
  ns.hasActivePageWire = hasActivePageWire
  ns.resolvePageRegistryKey = resolvePageRegistryKey
  ns.joinActivePageWire = joinActivePageWire
  ns.activePagePromises = inflightByKey
  ns.beginCoalescedNetworkFetch = beginCoalescedNetworkFetch
  ns.joinCoalescedNetworkFetch = joinCoalescedNetworkFetch
  ns.awaitCollapsedNetworkDelivery = awaitCollapsedNetworkDelivery
  ns.resolveCollapseWaitTimeoutMs = resolveCollapseWaitTimeoutMs
})()
