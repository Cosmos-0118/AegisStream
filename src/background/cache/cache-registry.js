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

function invariantKeysFromCacheKeys(cacheKeys) {
  const keys = new Set()
  if (!Array.isArray(cacheKeys)) return keys
  for (const raw of cacheKeys) {
    if (typeof raw !== "string" || !raw) continue
    if (raw.startsWith("aegis|")) {
      keys.add(raw)
      continue
    }
    if (typeof ns.buildMediaInvariantKey === "function") {
      const invariant = ns.buildMediaInvariantKey(raw)
      if (invariant) keys.add(invariant)
    }
  }
  return keys
}

function registerCacheKeys(cacheKeys) {
  const invariantKeys = invariantKeysFromCacheKeys(cacheKeys)
  if (!invariantKeys.size) return false
  let added = false
  for (const key of invariantKeys) {
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
  const invariantKeys = invariantKeysFromCacheKeys(cacheKeys)
  if (!invariantKeys.size) return false
  let removed = false
  for (const key of invariantKeys) {
    if (state.cacheRegistryKeys.delete(key)) removed = true
  }
  if (removed) {
    state.cacheRegistryGeneration += 1
    scheduleCacheRegistrySync()
  }
  return removed
}

function clearCacheRegistry() {
  if (state.cacheRegistryKeys.size === 0) return
  state.cacheRegistryKeys.clear()
  state.cacheRegistryGeneration += 1
  if (registrySyncTimer) {
    clearTimeout(registrySyncTimer)
    registrySyncTimer = null
  }
  void flushCacheRegistrySync("manual-purge")
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
    for (const key of invariantKeysFromCacheKeys(variants)) {
      state.cacheRegistryKeys.add(key)
    }
  }
  state.cacheRegistryGeneration += 1
  addLog(
    "INFO",
    `Rebuilt page cache registry with ${state.cacheRegistryKeys.size} invariant keys`
  )
  await flushCacheRegistrySync("db-rebuild")
  return state.cacheRegistryKeys.size
}

ns.registerCacheKeys = registerCacheKeys
ns.unregisterCacheKeys = unregisterCacheKeys
ns.clearCacheRegistry = clearCacheRegistry
ns.syncCacheRegistryToTab = syncCacheRegistryToTab
ns.scheduleCacheRegistrySync = scheduleCacheRegistrySync
ns.rebuildCacheRegistryFromDb = rebuildCacheRegistryFromDb
})()
