(() => {
var ns = (self.AegisBackground ||= {})
const { state, constants, addLog, buildCacheKeyVariants } = ns

if (!state.cacheRegistryKeys) {
  state.cacheRegistryKeys = new Set()
}
if (typeof state.cacheRegistryGeneration !== "number") {
  state.cacheRegistryGeneration = 0
}

let registrySyncTimer = null

/**
 * Project cache keys into the registry namespace.
 *
 * Must agree with the page's resolveRegistryKey contract, which falls back to
 * the hash-stripped URL when no invariant key can be derived. This previously
 * called buildMediaInvariantKey directly and dropped a null result, so any
 * stream whose segments carry a decoy extension (.../1080p/0042.jpg — not in
 * HLS_EXT) projected to zero keys: registerCacheKeys inserted nothing, the
 * registry stayed empty, and isCacheRegistryHit could never return true even
 * though the rows were in IndexedDB under their raw URL. Dedup then only
 * caught the refetch at store time, after the bytes were already on the wire.
 */
function registryKeysFromCacheKeys(cacheKeys) {
  const keys = new Set()
  if (!Array.isArray(cacheKeys)) return keys
  for (const raw of cacheKeys) {
    if (typeof raw !== "string" || !raw) continue
    if (raw.startsWith("aegis|") || raw.startsWith("range|")) {
      keys.add(raw)
      continue
    }
    // resolveRegistryKey already tries byte-range, then invariant, then
    // stripHash — the fallback is what keeps decoy-extension streams indexable.
    if (typeof ns.resolveRegistryKey === "function") {
      const key = ns.resolveRegistryKey(raw)
      if (key) keys.add(key)
      continue
    }
    const invariant =
      typeof ns.buildMediaInvariantKey === "function" ? ns.buildMediaInvariantKey(raw) : null
    keys.add(invariant || raw)
  }
  return keys
}

function registerCacheKeys(cacheKeys) {
  const registryKeys = registryKeysFromCacheKeys(cacheKeys)
  if (!registryKeys.size) return false
  let added = false
  for (const key of registryKeys) {
    if (!state.cacheRegistryKeys.has(key)) {
      state.cacheRegistryKeys.add(key)
      added = true
    }
  }
  if (added) {
    state.cacheRegistryGeneration += 1
    scheduleCacheRegistrySync()
  }
  return added
}

function unregisterCacheKeys(cacheKeys) {
  const registryKeys = registryKeysFromCacheKeys(cacheKeys)
  if (!registryKeys.size) return false
  let removed = false
  for (const key of registryKeys) {
    if (state.cacheRegistryKeys.delete(key)) removed = true
  }
  if (removed) {
    state.cacheRegistryGeneration += 1
    scheduleCacheRegistrySync()
  }
  return removed
}

/**
 * Whether a chunk URL is already represented in the registry.
 *
 * Read side of registerCacheKeys/unregisterCacheKeys, used by the prefetch
 * scheduler to avoid re-fetching content it already holds. A false negative
 * only costs a redundant fetch (the pre-existing behaviour); a false positive
 * skips a segment we do not actually have, so every path that deletes rows
 * must unregister their keys.
 */
function isCacheRegistryHit(url) {
  if (typeof url !== "string" || !url) return false
  if (!state.cacheRegistryKeys?.size) return false
  const variants =
    typeof buildCacheKeyVariants === "function" ? buildCacheKeyVariants(url) : [url]
  for (const key of registryKeysFromCacheKeys(variants)) {
    if (state.cacheRegistryKeys.has(key)) return true
  }
  return false
}

function clearCacheRegistry() {
  if (state.cacheRegistryKeys.size === 0) return Promise.resolve()
  state.cacheRegistryKeys.clear()
  state.cacheRegistryGeneration += 1
  if (registrySyncTimer) {
    clearTimeout(registrySyncTimer)
    registrySyncTimer = null
  }
  // Authoritative: page must drop its local view when background clears.
  return flushCacheRegistrySync("manual-purge")
}

/**
 * Replace-authoritative reasons clobber the page-side registry. Everything
 * else — most importantly `routine-sync` — is sent as additive merge so a
 * lagging or trimmed page-side registry can never produce a false negative
 * on `isLikelyCacheHitCandidate`.
 *
 * Page-side `applyCacheRegistrySync` enforces the same allowlist defensively
 * (coerces unknown reasons + replace=true into additive).
 */
const AUTHORITATIVE_REPLACE_REASONS = new Set([
  "db-rebuild",
  "tab-sync",
  "manual-purge",
  "authoritative-rebuild",
  "navigation-reset"
])

function buildRegistryPayload(reason = "routine-sync") {
  const maxKeys = Number(constants.CACHE_REGISTRY_MAX_KEYS) || 800
  const replace = AUTHORITATIVE_REPLACE_REASONS.has(reason)
  return {
    keys: Array.from(state.cacheRegistryKeys).slice(0, maxKeys),
    generation: state.cacheRegistryGeneration,
    replace,
    reason
  }
}

async function syncCacheRegistryToTab(tabId) {
  if (!Number.isFinite(tabId) || tabId < 0) return
  if (typeof ns.isTabMediaContext === "function" && !ns.isTabMediaContext(tabId)) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "AegisStream:CacheRegistrySync",
      payload: buildRegistryPayload("tab-sync")
    })
  } catch {
    // Tab may not have content script yet
  }
}

function scheduleCacheRegistrySync() {
  const debounceMs = Number(constants.CACHE_REGISTRY_SYNC_DEBOUNCE_MS) || 150
  if (registrySyncTimer) clearTimeout(registrySyncTimer)
  registrySyncTimer = setTimeout(() => {
    registrySyncTimer = null
    void flushCacheRegistrySync()
  }, debounceMs)
}

async function flushCacheRegistrySync(reason = "routine-sync") {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return
  }
  const payload = buildRegistryPayload(reason)
  for (const tab of tabs) {
    if (!tab?.id || tab.id < 0) continue
    if (
      typeof ns.isTabMediaContext === "function" &&
      !ns.isTabMediaContext(tab.id, tab.url)
    ) {
      continue
    }
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "AegisStream:CacheRegistrySync",
        payload
      })
    } catch {
      // ignore inactive tabs
    }
  }
}

async function rebuildCacheRegistryFromDb() {
  if (typeof ns.listCachedChunkKeys !== "function") return 0
  const urls = await ns.listCachedChunkKeys().catch(() => [])
  state.cacheRegistryKeys.clear()
  for (const url of urls) {
    const variants =
      typeof buildCacheKeyVariants === "function" ? buildCacheKeyVariants(url) : [url]
    for (const key of registryKeysFromCacheKeys(variants)) {
      state.cacheRegistryKeys.add(key)
    }
  }
  state.cacheRegistryGeneration += 1
  addLog(
    "INFO",
    `Rebuilt page cache registry with ${state.cacheRegistryKeys.size} registry keys`
  )
  await flushCacheRegistrySync("db-rebuild")
  return state.cacheRegistryKeys.size
}

ns.registerCacheKeys = registerCacheKeys
ns.isCacheRegistryHit = isCacheRegistryHit
ns.unregisterCacheKeys = unregisterCacheKeys
ns.clearCacheRegistry = clearCacheRegistry
ns.syncCacheRegistryToTab = syncCacheRegistryToTab
ns.scheduleCacheRegistrySync = scheduleCacheRegistrySync
ns.rebuildCacheRegistryFromDb = rebuildCacheRegistryFromDb
})()
