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
  /** Trust decay: how much the registry's "absent" verdict can be believed. */
  let lastRegistrySyncAt = 0
  let registryFalseNegativeUntil = 0
  const REGISTRY_FRESH_MS = 10_000
  const REGISTRY_FALSE_NEGATIVE_PENALTY_MS = 30_000
  const LOOKUP_CONFIDENCE_THRESHOLD = 0.3
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
    return typeof value === "string" && /^(?:range|aegis)\|/.test(value)
  }

  function resolveRegistryKeyLegacy(url) {
    if (!url || typeof url !== "string") return null
    if (url.startsWith("range|")) return url
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
    lastRegistrySyncAt = Date.now()

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

  function registerKeyVariants(url) {
    const keys = new Set()
    const coalesce = resolveCanonicalCoalesceKey(url)
    if (coalesce) keys.add(coalesce)
    const registry = resolveRegistryKey(url)
    if (registry) keys.add(registry)
    if (typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(url)
      if (invariant) keys.add(invariant)
    }
    return keys
  }

  function noteStoreIntent(url) {
    for (const key of registerKeyVariants(url)) {
      inflightCacheIntentKeys.add(key)
    }
    trimInflightIntentRegistry()
  }

  function noteLocalCacheKey(url) {
    const keys = registerKeyVariants(url)
    if (!keys.size) return
    for (const key of keys) {
      localizedCacheKeys.add(key)
      inflightCacheIntentKeys.delete(key)
    }
    trimRegistry()
    const labelKey = [...keys][0]
    touchRecentLocalAdd(labelKey)
    if (typeof ns.logBridge === "function") {
      ns.logBridge(
        `[REGISTRY] local-add gen=${registryGeneration} key=${registryKeyLabel(labelKey)} currentSize=${localizedCacheKeys.size}`,
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
   * Registry trust decay: a lookup that the registry claimed was absent turned
   * out to be an IDB hit. The registry is lagging — stop trusting its "absent"
   * verdicts for a while so every lookup goes to background.
   */
  function noteRegistryFalseNegative() {
    registryFalseNegativeUntil = Date.now() + REGISTRY_FALSE_NEGATIVE_PENALTY_MS
    if (typeof ns.reportRuntimeMetric === "function") {
      ns.reportRuntimeMetric("registry_false_negative", { generation: registryGeneration })
    }
  }

  /**
   * Confidence that a background lookup for this key is worth the IPC.
   * The registry is never trusted as an absolute "absent" oracle — its verdict
   * decays with sync staleness, and false negatives suspend trust entirely.
   *
   *   0.9  key known cached
   *   0.8  prefetch in flight for key
   *   0.5  registry never synced / stale / recently caught lying — lookup anyway
   *   0.2  fresh registry positively says absent
   */
  function resolveCacheConfidence(url) {
    if (isCachedKey(url)) return 0.9
    if (isInflightKey(url)) return 0.8
    if (typeof url === "string") {
      const swiftTransport = /\/EV9fQAQQ/i.test(url)
      const swiftSegmentTail = /ChkAT0wHWFUL/i.test(url)
      const playlistProxy =
        typeof ns.isSwiftStreamPlaylistProxy === "function" &&
        ns.isSwiftStreamPlaylistProxy(url)
      if ((swiftTransport || swiftSegmentTail) && !playlistProxy) {
        return 0.5
      }
    }
    const now = Date.now()
    if (now < registryFalseNegativeUntil) return 0.5
    if (!lastRegistrySyncAt) return 0.5
    if (now - lastRegistrySyncAt > REGISTRY_FRESH_MS) return 0.5
    return 0.2
  }

  /**
   * Disk-backed keys resolve instantly via IPC; in-flight keys route to collapse.
   * Unknown keys still get a lookup unless a *fresh* registry positively says absent.
   */
  function isLikelyCacheHitCandidate(url) {
    if (ns.extensionEnabled === false || ns.serveFromCache === false) return false

    const confidence = resolveCacheConfidence(url)
    const result = confidence >= LOOKUP_CONFIDENCE_THRESHOLD
    if (!result && typeof ns.logBridge === "function") {
      const key = resolveCanonicalCoalesceKey(url) || url
      ns.logBridge(
        `[REGISTRY] candidate-check gen=${registryGeneration} key=${registryKeyLabel(key)} present=false confidence=${confidence.toFixed(2)}`,
        "DEBUG"
      )
    }
    return result
  }

  ns.applyCacheRegistrySync = applyCacheRegistrySync
  ns.noteLocalCacheKey = noteLocalCacheKey
  ns.noteStoreIntent = noteStoreIntent
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
  ns.resolveCacheConfidence = resolveCacheConfidence
  ns.noteRegistryFalseNegative = noteRegistryFalseNegative
  ns.isLikelyCacheHitCandidate = isLikelyCacheHitCandidate
  ns.resolveCanonicalCoalesceKey = resolveCanonicalCoalesceKey
  ns.resolveRegistryKey = resolveRegistryKey
})()
