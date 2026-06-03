/**
 * Synchronous page-local cache key registry (MAIN world).
 * Avoids IPC when invariant key is known absent from IndexedDB.
 */
(() => {
  const ns = (globalThis.AegisPageBridge ||= {})

  const MAX_LOCAL_REGISTRY_KEYS = 800
  const localizedCacheKeys = new Set()
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

  function noteLocalCacheKey(url) {
    const key = resolveRegistryKey(url)
    if (!key) return
    localizedCacheKeys.add(key)
    trimRegistry()
  }

  function removeLocalCacheKey(url) {
    const key = resolveRegistryKey(url)
    if (!key) return
    localizedCacheKeys.delete(key)
  }

  /**
   * True only when the local registry proves the key exists in background IDB.
   */
  function isLikelyCacheHitCandidate(url) {
    if (ns.extensionEnabled === false || ns.serveFromCache === false) return false
    if (typeof url === "string" && url.startsWith("ump|")) {
      return localizedCacheKeys.has(url) || ns.knownUmpCacheKeys?.has?.(url) === true
    }
    const key = resolveRegistryKey(url)
    if (!key) return false
    return localizedCacheKeys.has(key)
  }

  ns.applyCacheRegistrySync = applyCacheRegistrySync
  ns.noteLocalCacheKey = noteLocalCacheKey
  ns.removeLocalCacheKey = removeLocalCacheKey
  ns.isLikelyCacheHitCandidate = isLikelyCacheHitCandidate
  ns.resolveRegistryKey = resolveRegistryKey
})()
