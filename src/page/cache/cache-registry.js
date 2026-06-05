/**
 * Synchronous page-local cache key registry (MAIN world).
 * Avoids IPC when invariant key is known absent from IndexedDB.
 */
(() => {
  const ns = (globalThis.AegisPageBridge ||= {})

  const MAX_LOCAL_REGISTRY_KEYS = 800
  const MAX_INFLIGHT_INTENT_KEYS = 400
  const localizedCacheKeys = new Set()
  /** Keys with delegated/in-flight prefetch — enables lookup + collapse before IDB write. */
  const inflightCacheIntentKeys = new Set()
  let registryGeneration = 0
  /** Recent page-local key assertions — used to flag sync-replace evictions in traces. */
  const recentLocalAdds = new Map()
  const LOCAL_ADD_TRACE_MS = 30_000

  function registryKeyLabel(key) {
    if (typeof key !== "string" || !key) return "unknown"
    return key.length > 72 ? key.slice(-72) : key
  }

  function pruneRecentLocalAdds(now = Date.now()) {
    for (const [key, addedAt] of recentLocalAdds.entries()) {
      if (now - addedAt > LOCAL_ADD_TRACE_MS) recentLocalAdds.delete(key)
    }
  }

  function touchRecentLocalAdd(key) {
    if (!key) return
    recentLocalAdds.set(key, Date.now())
    pruneRecentLocalAdds()
  }

  function countRecentLocalAddsEvicted(incomingKeys) {
    let evicted = 0
    const now = Date.now()
    for (const [key, addedAt] of recentLocalAdds.entries()) {
      if (now - addedAt > LOCAL_ADD_TRACE_MS) continue
      if (!incomingKeys.has(key)) evicted += 1
    }
    return evicted
  }

  function isCanonicalCoalesceKey(value) {
    return typeof value === "string" && /^(?:range|aegis|ump)\|/.test(value)
  }

  function resolveRegistryKeyLegacy(url) {
    if (!url || typeof url !== "string") return null
    if (url.startsWith("ump|") || url.startsWith("range|")) return url
    if (typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(url)
      if (invariant) return invariant
    }
    if (typeof ns.stripHash === "function") return ns.stripHash(url)
    return url.split("#")[0]
  }

  /**
   * Coalescing identity — payload matching only. Never retains volatile CDN tokens.
   * Decoupled from resolveRegistryKey (storage/disk addressing namespace).
   */
  function resolveCanonicalCoalesceKey(url) {
    if (!url || typeof url !== "string") return null
    if (isCanonicalCoalesceKey(url)) return url
    if (typeof ns.resolveNetworkCoalesceKey === "function") {
      const unified = ns.resolveNetworkCoalesceKey(url, null)
      if (unified) return unified
    }
    return null
  }

  /** Storage/disk registry namespace — may retain full URL when invariants are unavailable. */
  function resolveRegistryKey(url) {
    return resolveRegistryKeyLegacy(url)
  }

  function trimRegistry() {
    if (localizedCacheKeys.size <= MAX_LOCAL_REGISTRY_KEYS) return
    const excess = localizedCacheKeys.size - MAX_LOCAL_REGISTRY_KEYS
    let removed = 0
    for (const key of localizedCacheKeys) {
      localizedCacheKeys.delete(key)
      removed += 1
      if (removed >= excess) break
    }
  }

  /**
   * Reasons authorised to issue a destructive replace.
   *
   * Anything outside this set is coerced to additive merge — so a future
   * background change that accidentally sends `replace: true` with a routine
   * reason cannot silently nuke the page-side registry and create false
   * negatives on `isLikelyCacheHitCandidate`.
   */
  const AUTHORITATIVE_REPLACE_REASONS = new Set([
    "db-rebuild",
    "tab-sync",
    "manual-purge",
    "authoritative-rebuild",
    "navigation-reset"
  ])

  function applyCacheRegistrySync(payload = {}) {
    if (typeof ns.isMediaBridgeActive === "function" && !ns.isMediaBridgeActive()) {
      if (typeof ns.activateMediaBridge === "function") {
        ns.activateMediaBridge(payload.reason || "registry-sync")
      } else {
        return
      }
    }

    const reason = payload.reason || "routine-sync"
    const requestedReplace = payload.replace === true
    const replaceAuthorized = requestedReplace && AUTHORITATIVE_REPLACE_REASONS.has(reason)
    const replaceCoerced = requestedReplace && !replaceAuthorized

    const incomingKeys = Array.isArray(payload.keys)
      ? payload.keys.filter((key) => typeof key === "string" && key)
      : []
    const removedKeys = Array.isArray(payload.removedKeys)
      ? payload.removedKeys.filter((key) => typeof key === "string" && key)
      : []
    const incomingSet = new Set(incomingKeys)
    const preSize = localizedCacheKeys.size
    let evictedPageAhead = 0

    if (replaceAuthorized) {
      for (const key of localizedCacheKeys) {
        if (!incomingSet.has(key)) evictedPageAhead += 1
      }
      localizedCacheKeys.clear()
    }

    // Additive merge — routine syncs can only ADD keys, never silently remove
    // them. Removals must come through `removedKeys` (explicit delta) or
    // `removeLocalCacheKey` on eviction.
    for (const key of incomingKeys) {
      localizedCacheKeys.add(key)
    }

    let appliedRemovals = 0
    if (!replaceAuthorized && removedKeys.length > 0) {
      for (const key of removedKeys) {
        if (localizedCacheKeys.delete(key)) appliedRemovals += 1
      }
    }

    trimRegistry()
    registryGeneration = Number(payload.generation) || registryGeneration + 1

    if (typeof ns.logBridge === "function") {
      const recentEvicted = replaceAuthorized ? countRecentLocalAddsEvicted(incomingSet) : 0
      const mode = replaceAuthorized
        ? "replace-authoritative"
        : replaceCoerced
          ? "replace-coerced-to-additive"
          : "additive"
      ns.logBridge(
        `[REGISTRY] sync gen=${payload.generation ?? "?"} reason=${reason} mode=${mode} incoming=${incomingKeys.length} removed=${appliedRemovals} preSize=${preSize} postSize=${localizedCacheKeys.size} evicted=${evictedPageAhead} recentLocalEvicted=${recentEvicted}`,
        replaceCoerced || recentEvicted > 0 ? "WARN" : "DEBUG"
      )
    }

    if (replaceCoerced && typeof ns.reportRuntimeMetric === "function") {
      ns.reportRuntimeMetric("registry_sync_replace_coerced", { reason })
    }
  }

  function trimInflightIntentRegistry() {
    if (inflightCacheIntentKeys.size <= MAX_INFLIGHT_INTENT_KEYS) return
    const excess = inflightCacheIntentKeys.size - MAX_INFLIGHT_INTENT_KEYS
    let removed = 0
    for (const key of inflightCacheIntentKeys) {
      inflightCacheIntentKeys.delete(key)
      removed += 1
      if (removed >= excess) break
    }
  }

  function noteLocalCacheKey(url) {
    const key = resolveCanonicalCoalesceKey(url)
    if (!key) return
    localizedCacheKeys.add(key)
    inflightCacheIntentKeys.delete(key)
    trimRegistry()
    touchRecentLocalAdd(key)
    if (typeof ns.logBridge === "function") {
      ns.logBridge(
        `[REGISTRY] local-add gen=${registryGeneration} key=${registryKeyLabel(key)} currentSize=${localizedCacheKeys.size}`,
        "DEBUG"
      )
    }
  }

  function removeLocalCacheKey(url) {
    const key = resolveCanonicalCoalesceKey(url)
    if (!key) return
    localizedCacheKeys.delete(key)
    inflightCacheIntentKeys.delete(key)
  }

  function hasLocalizedDiskEntry(url) {
    if (typeof url === "string" && isCanonicalCoalesceKey(url) && localizedCacheKeys.has(url)) {
      return true
    }
    const coalesce = resolveCanonicalCoalesceKey(url)
    if (coalesce && localizedCacheKeys.has(coalesce)) return true
    if (typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(url)
      if (invariant && localizedCacheKeys.has(invariant)) return true
    }
    return false
  }

  function notePrefetchIntent(url) {
    const key = resolveCanonicalCoalesceKey(url)
    if (!key || hasLocalizedDiskEntry(url)) return
    inflightCacheIntentKeys.add(key)
    trimInflightIntentRegistry()
  }

  function notePrefetchIntentBatch(urls) {
    if (!Array.isArray(urls)) return
    for (const url of urls) {
      notePrefetchIntent(url)
    }
  }

  function clearPrefetchIntent(url) {
    const key = resolveCanonicalCoalesceKey(url)
    if (!key) return
    inflightCacheIntentKeys.delete(key)
  }

  function clearPrefetchIntentBatch(urls) {
    if (!Array.isArray(urls)) return
    for (const url of urls) {
      clearPrefetchIntent(url)
    }
  }

  function isCachedKey(url) {
    return hasLocalizedDiskEntry(url)
  }

  function isInflightKey(url) {
    if (typeof url === "string" && isCanonicalCoalesceKey(url)) {
      return inflightCacheIntentKeys.has(url)
    }
    const key = resolveCanonicalCoalesceKey(url)
    return key ? inflightCacheIntentKeys.has(key) : false
  }

  /**
   * Disk-backed keys resolve instantly via IPC; in-flight keys route to collapse.
   */
  function isLikelyCacheHitCandidate(url) {
    if (ns.extensionEnabled === false || ns.serveFromCache === false) return false

    const key = resolveCanonicalCoalesceKey(url) || url
    let cached = false
    let inflight = false
    let umpKnown = false

    if (typeof url === "string" && url.startsWith("ump|")) {
      cached = isCachedKey(url)
      inflight = isInflightKey(url)
      umpKnown = ns.knownUmpCacheKeys?.has?.(url) === true
      const result = cached || inflight || umpKnown
      if (!result && typeof ns.logBridge === "function") {
        ns.logBridge(
          `[REGISTRY] candidate-check gen=${registryGeneration} key=${registryKeyLabel(key)} present=false (cached=${cached}, inflight=${inflight}, umpKnown=${umpKnown})`,
          "DEBUG"
        )
      }
      return result
    }

    cached = isCachedKey(url)
    inflight = isInflightKey(url)
    const result = cached || inflight
    if (!result && typeof ns.logBridge === "function") {
      ns.logBridge(
        `[REGISTRY] candidate-check gen=${registryGeneration} key=${registryKeyLabel(key)} present=false (cached=${cached}, inflight=${inflight})`,
        "DEBUG"
      )
    }
    return result
  }

  ns.applyCacheRegistrySync = applyCacheRegistrySync
  ns.noteLocalCacheKey = noteLocalCacheKey
  ns.removeLocalCacheKey = removeLocalCacheKey
  ns.notePrefetchIntent = notePrefetchIntent
  ns.notePrefetchIntentBatch = notePrefetchIntentBatch
  ns.clearPrefetchIntent = clearPrefetchIntent
  ns.clearPrefetchIntentBatch = clearPrefetchIntentBatch
  ns.cachedKeys = localizedCacheKeys
  ns.inFlightKeys = inflightCacheIntentKeys
  ns.isCachedKey = isCachedKey
  ns.isInflightKey = isInflightKey
  ns.isKeyInFlight = isInflightKey
  ns.isLikelyCacheHitCandidate = isLikelyCacheHitCandidate
  ns.resolveCanonicalCoalesceKey = resolveCanonicalCoalesceKey
  ns.resolveRegistryKey = resolveRegistryKey
})()
