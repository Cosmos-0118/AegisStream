/**
 * Page-local L1 hot byte cache (MAIN world).
 * Serves segment bytes synchronously with zero IPC when the player re-requests
 * a recently prefetched / collapsed / network-captured chunk.
 *
 * Production invariants:
 * - Never serve when extension/cache serving is disabled
 * - Always clone on get (Response/XHR consumers may detach buffers)
 * - Bound memory, aliases, and waiters; always time out waiters
 * - Drop detached/corrupt entries instead of serving empty payloads
 */
(() => {
  const ns = (globalThis.AegisPageBridge ||= {})

  const MAX_ENTRIES = 128
  const MAX_BYTES = 96 * 1024 * 1024
  const MAX_ENTRY_BYTES = 16 * 1024 * 1024
  const MAX_ALIASES = 256
  const MAX_WAITERS_PER_KEY = 32
  const MAX_WAITER_KEYS = 64
  const DEFAULT_WAITER_TIMEOUT_MS = 8_000
  const ENTRY_TTL_MS = 120_000

  /** @type {Map<string, { bytes: ArrayBuffer, contentType: string, status: number, byteLength: number, storedAt: number }>} */
  const entries = new Map()
  /** Alias key → primary entry key */
  const aliases = new Map()
  let totalBytes = 0

  /** @type {Map<string, Set<(payload: object|null) => void>>} */
  const waitersByKey = new Map()

  function isServingEnabled() {
    return ns.extensionEnabled !== false && ns.serveFromCache !== false
  }

  function isCanonicalCoalesceKey(value) {
    return typeof value === "string" && /^(?:range|aegis)\|/.test(value)
  }

  function resolveHotKey(keyOrUrl, cacheKey = null) {
    if (!keyOrUrl && !cacheKey) return null
    if (isCanonicalCoalesceKey(cacheKey)) return cacheKey
    if (isCanonicalCoalesceKey(keyOrUrl)) return keyOrUrl
    if (typeof ns.resolveNetworkCoalesceKey === "function") {
      const coalesced = ns.resolveNetworkCoalesceKey(keyOrUrl, cacheKey)
      if (coalesced) return coalesced
    }
    if (typeof ns.resolveCanonicalCoalesceKey === "function") {
      const coalesced = ns.resolveCanonicalCoalesceKey(keyOrUrl || cacheKey)
      if (coalesced) return coalesced
    }
    if (typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(keyOrUrl || cacheKey)
      if (invariant) return invariant
    }
    if (typeof ns.stripHash === "function") {
      return ns.stripHash(keyOrUrl || cacheKey)
    }
    const raw = String(keyOrUrl || cacheKey || "")
    return raw ? raw.split("#")[0] : null
  }

  function cloneBytes(bytes) {
    if (!bytes) return null
    try {
      if (bytes instanceof ArrayBuffer) {
        if (bytes.byteLength <= 0) return null
        return bytes.slice(0)
      }
      if (ArrayBuffer.isView(bytes)) {
        if (bytes.byteLength <= 0) return null
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
      if (typeof bytes.byteLength === "number" && bytes.buffer) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    } catch {
      // Detached ArrayBuffer / neutered view
      return null
    }
    return null
  }

  function dropEntry(key) {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    totalBytes = Math.max(0, totalBytes - (Number(entry.byteLength) || 0))
    for (const [alias, primary] of aliases.entries()) {
      if (primary === key || alias === key) aliases.delete(alias)
    }
  }

  function touchEntry(key) {
    const entry = entries.get(key)
    if (!entry) return null
    entries.delete(key)
    entries.set(key, entry)
    return entry
  }

  function resolvePrimaryKey(keyOrUrl, cacheKey = null) {
    const key = resolveHotKey(keyOrUrl, cacheKey)
    if (!key) return null
    if (entries.has(key)) return key
    const aliased = aliases.get(key)
    if (aliased && entries.has(aliased)) return aliased
    if (aliased && !entries.has(aliased)) aliases.delete(key)
    return key
  }

  function pruneAliases() {
    for (const [alias, primary] of aliases.entries()) {
      if (!entries.has(primary)) aliases.delete(alias)
    }
    while (aliases.size > MAX_ALIASES) {
      const oldest = aliases.keys().next().value
      if (!oldest) break
      aliases.delete(oldest)
    }
  }

  function evictOverflow() {
    const now = Date.now()
    for (const [key, entry] of entries.entries()) {
      if (now - Number(entry.storedAt || 0) > ENTRY_TTL_MS) dropEntry(key)
    }
    while (entries.size > MAX_ENTRIES || totalBytes > MAX_BYTES) {
      const oldest = entries.keys().next().value
      if (!oldest) break
      dropEntry(oldest)
    }
    pruneAliases()
  }

  function buildServePayload(entry) {
    const bytes = cloneBytes(entry.bytes)
    if (!bytes || bytes.byteLength <= 0) return null
    return {
      ok: true,
      hit: true,
      bytes,
      contentType: entry.contentType,
      status: entry.status,
      byteLength: bytes.byteLength,
      fromCache: true,
      via: "hot-l1"
    }
  }

  function wakeWaiters(key, payload) {
    const waiters = waitersByKey.get(key)
    if (!waiters || waiters.size === 0) return
    waitersByKey.delete(key)
    for (const resolve of waiters) {
      try {
        // Each waiter gets an independent clone — Response bodies are one-shot.
        const delivered =
          payload?.ok && payload.bytes
            ? {
                ...payload,
                bytes: cloneBytes(payload.bytes) || payload.bytes
              }
            : payload
        resolve(delivered)
      } catch {
        // ignore waiter faults
      }
    }
  }

  function registerAlias(aliasKey, primaryKey) {
    if (!aliasKey || !primaryKey || aliasKey === primaryKey) return
    aliases.set(aliasKey, primaryKey)
    pruneAliases()
  }

  function putHotBytes(keyOrUrl, bytes, meta = {}) {
    if (!isServingEnabled()) return false
    const key = resolveHotKey(keyOrUrl, meta.cacheKey || null)
    if (!key) return false
    const cloned = cloneBytes(bytes)
    if (!cloned || cloned.byteLength <= 0) return false
    if (cloned.byteLength > MAX_ENTRY_BYTES) return false

    const existing = entries.get(key)
    if (
      existing &&
      existing.byteLength === cloned.byteLength &&
      Date.now() - Number(existing.storedAt || 0) < 2_000
    ) {
      // Fresh identical-size put — refresh TTL / aliases without realloc churn.
      existing.storedAt = Date.now()
      existing.contentType = meta.contentType || existing.contentType
      touchEntry(key)
      if (meta.aliasKey) registerAlias(resolveHotKey(meta.aliasKey), key)
      if (meta.pageUrl && meta.pageUrl !== keyOrUrl) {
        registerAlias(resolveHotKey(meta.pageUrl), key)
      }
      const refreshPayload = buildServePayload(existing)
      if (refreshPayload) {
        wakeWaiters(key, refreshPayload)
        for (const [alias, primary] of aliases.entries()) {
          if (primary === key) wakeWaiters(alias, refreshPayload)
        }
      }
      return true
    }

    if (existing) {
      totalBytes = Math.max(0, totalBytes - (existing.byteLength || 0))
      entries.delete(key)
    }

    const entry = {
      bytes: cloned,
      contentType: meta.contentType || "application/octet-stream",
      status: Number(meta.status) || 200,
      byteLength: cloned.byteLength,
      storedAt: Date.now()
    }
    entries.set(key, entry)
    totalBytes += entry.byteLength

    if (meta.aliasKey) registerAlias(resolveHotKey(meta.aliasKey), key)
    if (meta.pageUrl && meta.pageUrl !== keyOrUrl) {
      registerAlias(resolveHotKey(meta.pageUrl), key)
    }

    evictOverflow()

    const payload = buildServePayload(entry)
    if (payload) {
      wakeWaiters(key, payload)
      for (const [alias, primary] of aliases.entries()) {
        if (primary === key) wakeWaiters(alias, payload)
      }
    }

    if (typeof ns.noteLocalCacheKey === "function") {
      try {
        ns.noteLocalCacheKey(keyOrUrl || key)
      } catch {
        // registry faults must never break the serve path
      }
    }
    return true
  }

  function getHotBytes(keyOrUrl, cacheKey = null) {
    if (!isServingEnabled()) return null
    const primary = resolvePrimaryKey(keyOrUrl, cacheKey)
    if (!primary || !entries.has(primary)) return null
    const entry = touchEntry(primary)
    if (!entry) return null
    if (Date.now() - Number(entry.storedAt || 0) > ENTRY_TTL_MS) {
      dropEntry(primary)
      return null
    }
    const payload = buildServePayload(entry)
    if (!payload) {
      // Detached buffer — drop corrupt entry rather than serving empty.
      dropEntry(primary)
      return null
    }
    return payload
  }

  function hasHotBytes(keyOrUrl, cacheKey = null) {
    if (!isServingEnabled()) return false
    const primary = resolvePrimaryKey(keyOrUrl, cacheKey)
    if (!primary || !entries.has(primary)) return false
    const entry = entries.get(primary)
    if (!entry) return false
    if (Date.now() - Number(entry.storedAt || 0) > ENTRY_TTL_MS) {
      dropEntry(primary)
      return false
    }
    return true
  }

  function aliasHotBytes(fromKeyOrUrl, toKeyOrUrl) {
    const fromKey = resolveHotKey(fromKeyOrUrl)
    const toKey = resolveHotKey(toKeyOrUrl)
    if (!fromKey || !toKey || fromKey === toKey) return false
    if (entries.has(toKey)) {
      registerAlias(fromKey, toKey)
      return true
    }
    if (entries.has(fromKey)) {
      registerAlias(toKey, fromKey)
      return true
    }
    const fromPrimary = aliases.get(fromKey)
    if (fromPrimary && entries.has(fromPrimary)) {
      registerAlias(toKey, fromPrimary)
      return true
    }
    return false
  }

  function clearHotByteCache(reason = "manual") {
    entries.clear()
    aliases.clear()
    totalBytes = 0
    for (const waiters of waitersByKey.values()) {
      for (const resolve of waiters) {
        try {
          resolve(null)
        } catch {
          // ignore
        }
      }
    }
    waitersByKey.clear()
    if (typeof ns.reportRuntimeMetric === "function") {
      ns.reportRuntimeMetric("hot_cache_cleared", { reason: String(reason || "manual") })
    }
  }

  function pruneWaiterKeys() {
    while (waitersByKey.size > MAX_WAITER_KEYS) {
      const oldest = waitersByKey.keys().next().value
      if (!oldest) break
      const waiters = waitersByKey.get(oldest)
      waitersByKey.delete(oldest)
      if (!waiters) continue
      for (const resolve of waiters) {
        try {
          resolve(null)
        } catch {
          // ignore
        }
      }
    }
  }

  function awaitHotBytes(keyOrUrl, cacheKey = null, options = {}) {
    if (!isServingEnabled()) return Promise.resolve(null)
    const key = resolveHotKey(keyOrUrl, cacheKey)
    if (!key) return Promise.resolve(null)
    const existing = getHotBytes(keyOrUrl, cacheKey)
    if (existing?.bytes) return Promise.resolve(existing)

    const timeoutMs = Math.max(
      1,
      Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : DEFAULT_WAITER_TIMEOUT_MS
    )

    return new Promise((resolve) => {
      let settled = false
      const finish = (payload) => {
        if (settled) return
        settled = true
        if (timerId != null) clearTimeout(timerId)
        const set = waitersByKey.get(key)
        if (set) {
          set.delete(finish)
          if (set.size === 0) waitersByKey.delete(key)
        }
        resolve(payload)
      }

      let waiters = waitersByKey.get(key)
      if (!waiters) {
        waiters = new Set()
        waitersByKey.set(key, waiters)
        pruneWaiterKeys()
      }
      if (waiters.size >= MAX_WAITERS_PER_KEY) {
        // Bound memory under scrub storms — fail closed to poll/IPC path.
        resolve(null)
        return
      }
      waiters.add(finish)

      const timerId = setTimeout(() => finish(null), timeoutMs)
    })
  }

  function getHotByteCacheStats() {
    return {
      entries: entries.size,
      aliases: aliases.size,
      totalBytes,
      waiters: waitersByKey.size,
      maxEntries: MAX_ENTRIES,
      maxBytes: MAX_BYTES
    }
  }

  function clearCacheState(options = {}) {
    clearHotByteCache(options.reason || "clear-cache-state")
  }

  ns.putHotBytes = putHotBytes
  ns.getHotBytes = getHotBytes
  ns.hasHotBytes = hasHotBytes
  ns.aliasHotBytes = aliasHotBytes
  ns.clearHotByteCache = clearHotByteCache
  ns.awaitHotBytes = awaitHotBytes
  ns.getHotByteCacheStats = getHotByteCacheStats
  ns.resolveHotByteKey = resolveHotKey
  ns.clearCacheState = clearCacheState
})()
