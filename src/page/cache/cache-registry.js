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

  function resolveRegistryKey(url) {
    if (!url || typeof url !== "string") return null
    if (typeof url === "string" && url.startsWith("ump|")) return url
    if (typeof url === "string" && url.startsWith("range|")) return url
    if (typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(url)
      if (invariant) return invariant
    }
    if (typeof ns.stripHash === "function") return ns.stripHash(url)
    return url.split("#")[0]
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

  function applyCacheRegistrySync(payload = {}) {
    const replace = payload.replace !== false
    if (replace) localizedCacheKeys.clear()
    const keys = Array.isArray(payload.keys) ? payload.keys : []
    for (const key of keys) {
      if (typeof key === "string" && key) localizedCacheKeys.add(key)
    }
    trimRegistry()
    registryGeneration = Number(payload.generation) || registryGeneration + 1
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
    const key = resolveRegistryKey(url)
    if (!key) return
    localizedCacheKeys.add(key)
    inflightCacheIntentKeys.delete(key)
    trimRegistry()
  }

  function removeLocalCacheKey(url) {
    const key = resolveRegistryKey(url)
    if (!key) return
    localizedCacheKeys.delete(key)
    inflightCacheIntentKeys.delete(key)
  }

  function notePrefetchIntent(url) {
    const key = resolveRegistryKey(url)
    if (!key || localizedCacheKeys.has(key)) return
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
    const key = resolveRegistryKey(url)
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
    if (typeof url === "string" && url.startsWith("ump|")) {
      return localizedCacheKeys.has(url)
    }
    const key = resolveRegistryKey(url)
    return key ? localizedCacheKeys.has(key) : false
  }

  function isInflightKey(url) {
    if (typeof url === "string" && url.startsWith("ump|")) {
      return inflightCacheIntentKeys.has(url)
    }
    const key = resolveRegistryKey(url)
    return key ? inflightCacheIntentKeys.has(key) : false
  }

  /**
   * Disk-backed keys resolve instantly via IPC; in-flight keys route to collapse.
   */
  function isLikelyCacheHitCandidate(url) {
    if (ns.extensionEnabled === false || ns.serveFromCache === false) return false
    if (typeof url === "string" && url.startsWith("ump|")) {
      return (
        isCachedKey(url) ||
        isInflightKey(url) ||
        ns.knownUmpCacheKeys?.has?.(url) === true
      )
    }
    return isCachedKey(url) || isInflightKey(url)
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
  ns.isLikelyCacheHitCandidate = isLikelyCacheHitCandidate
  ns.resolveRegistryKey = resolveRegistryKey
})()
