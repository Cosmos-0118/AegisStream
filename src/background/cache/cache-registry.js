(() => {
var ns = (self.AegisBackground ||= {})
const { state, constants, addLog, buildCacheKeyVariants, isUmpCacheKey, getUmpBodyHashFromCacheKey } = ns

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
    if (isUmpCacheKey(raw)) {
      keys.add(raw)
      const bodyHash = getUmpBodyHashFromCacheKey(raw)
      if (bodyHash) keys.add(`ump|${bodyHash}`)
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
  scheduleCacheRegistrySync()
}

function buildRegistryPayload() {
  const maxKeys = Number(constants.CACHE_REGISTRY_MAX_KEYS) || 800
  return {
    keys: Array.from(state.cacheRegistryKeys).slice(0, maxKeys),
    generation: state.cacheRegistryGeneration,
    replace: true
  }
}

async function syncCacheRegistryToTab(tabId) {
  if (!Number.isFinite(tabId) || tabId < 0) return
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "AegisStream:CacheRegistrySync",
      payload: buildRegistryPayload()
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

async function flushCacheRegistrySync() {
  let tabs = []
  try {
    tabs = await chrome.tabs.query({})
  } catch {
    return
  }
  const payload = buildRegistryPayload()
  for (const tab of tabs) {
    if (!tab?.id || tab.id < 0) continue
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
  await flushCacheRegistrySync()
  return state.cacheRegistryKeys.size
}

ns.registerCacheKeys = registerCacheKeys
ns.unregisterCacheKeys = unregisterCacheKeys
ns.clearCacheRegistry = clearCacheRegistry
ns.syncCacheRegistryToTab = syncCacheRegistryToTab
ns.scheduleCacheRegistrySync = scheduleCacheRegistrySync
ns.rebuildCacheRegistryFromDb = rebuildCacheRegistryFromDb
})()
