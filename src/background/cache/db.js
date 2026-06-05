(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog, stripHash, buildCacheKeyVariants, isUmpCacheKey, getUmpBodyHashFromCacheKey } = ns
let evictionInProgress = false
let lastEvictionRunAt = 0
let storageSystemOperational = true
let storageBypassLogged = false

function isStorageFailureError(error) {
  const name = String(error?.name || "")
  const message = String(error?.message || "").toLowerCase()
  return (
    name === "QuotaExceededError" ||
    name === "InvalidStateError" ||
    name === "UnknownError" ||
    message.includes("quota") ||
    message.includes("corrupt") ||
    message.includes("database") ||
    message.includes("indexeddb") ||
    message.includes("storage")
  )
}

function triggerEmergencyCacheEviction() {
  if (typeof ns.scheduleEviction === "function") {
    ns.scheduleEviction(true)
  }
}

function engageStoragePassthroughValve(reason, error) {
  if (!storageSystemOperational) return
  storageSystemOperational = false
  state.settings.serveFromCache = false
  triggerEmergencyCacheEviction()
  if (!storageBypassLogged) {
    storageBypassLogged = true
    const detail = error?.message ? `: ${error.message}` : ""
    addLog(
      "ERROR",
      `Hard storage failure (${reason}) — pass-through safety valve engaged${detail}`
    )
    if (typeof ns.recordDecision === "function") {
      ns.recordDecision("storage", "bypass", reason)
    }
  }
  if (typeof ns.broadcastSettingsToTabs === "function") {
    void ns.broadcastSettingsToTabs(state.settings)
  }
}

function isStorageSystemOperational() {
  return storageSystemOperational
}

function getByteLength(value) {
  if (!value) return 0
  const hinted = Number(value.byteLength)
  if (Number.isFinite(hinted) && hinted >= 0) return hinted
  const bytes = value.bytes
  if (bytes && typeof bytes.byteLength === "number" && bytes.byteLength >= 0) {
    return bytes.byteLength
  }
  return 0
}

function resolveBudgetFromDeviceMemory() {
  const memoryGb = Number(self?.navigator?.deviceMemory || 0)
  if (!Number.isFinite(memoryGb) || memoryGb <= 0) {
    return 384 * 1024 * 1024
  }
  if (memoryGb <= 2) return 128 * 1024 * 1024
  if (memoryGb <= 4) return 256 * 1024 * 1024
  if (memoryGb <= 8) return 512 * 1024 * 1024
  return 768 * 1024 * 1024
}

async function computeAdaptiveCachePolicy(force = false) {
  const now = Date.now()
  if (
    !force &&
    state.cachePolicy?.lastComputedAt &&
    now - state.cachePolicy.lastComputedAt < constants.CACHE_POLICY_REFRESH_MS
  ) {
    return state.cachePolicy
  }

  const configuredMaxEntries = Math.max(50, Number(state.settings.maxEntries) || 50)
  const avgChunkBytes = Math.max(
    64 * 1024,
    Number(state.cachePolicy?.avgChunkBytes || constants.CACHE_DEFAULT_AVG_CHUNK_BYTES)
  )

  let maxBytes = Math.min(
    constants.CACHE_MAX_BYTES,
    Math.max(
      constants.CACHE_MIN_BYTES,
      Math.round(Math.min(resolveBudgetFromDeviceMemory(), avgChunkBytes * configuredMaxEntries * 1.25))
    )
  )

  try {
    if (navigator?.storage?.estimate) {
      const estimate = await navigator.storage.estimate()
      const quota = Number(estimate?.quota || 0)
      const usage = Number(estimate?.usage || 0)
      if (Number.isFinite(quota) && quota > 0) {
        const free = Math.max(0, quota - usage)
        const quotaBudget = quota * constants.CACHE_QUOTA_TARGET_FRACTION
        const freeAfterHeadroom = Math.max(0, free - constants.CACHE_POLICY_HEADROOM_BYTES)
        const freeBudget = Math.max(
          constants.CACHE_MIN_BYTES / 2,
          freeAfterHeadroom * constants.CACHE_FREE_SPACE_TARGET_FRACTION
        )
        maxBytes = Math.round(
          Math.max(
            constants.CACHE_MIN_BYTES / 2,
            Math.min(maxBytes, quotaBudget, freeBudget, constants.CACHE_MAX_BYTES)
          )
        )
      }
    }
  } catch {
    // Ignore estimate failures and keep memory-derived policy.
  }

  const maxEntriesByBytes = Math.max(50, Math.floor(maxBytes / avgChunkBytes))
  const maxEntries = Math.max(50, Math.min(configuredMaxEntries, maxEntriesByBytes))

  state.cachePolicy = {
    maxEntries,
    maxBytes,
    avgChunkBytes,
    lastComputedAt: now
  }
  return state.cachePolicy
}

function openDb() {
  if (!storageSystemOperational) {
    return Promise.reject(new Error("storage-bypass"))
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(constants.DB_NAME, constants.DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(constants.STORE_CHUNKS)) {
        const chunks = db.createObjectStore(constants.STORE_CHUNKS, { keyPath: "url" })
        chunks.createIndex("createdAt", "createdAt", { unique: false })
      }
      if (!db.objectStoreNames.contains(constants.STORE_ALIASES)) {
        const aliases = db.createObjectStore(constants.STORE_ALIASES, { keyPath: "alias" })
        aliases.createIndex("createdAt", "createdAt", { unique: false })
        aliases.createIndex("targetUrl", "targetUrl", { unique: false })
      } else {
        const aliases = req.transaction.objectStore(constants.STORE_ALIASES)
        if (!aliases.indexNames.contains("targetUrl")) {
          aliases.createIndex("targetUrl", "targetUrl", { unique: false })
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      const err = req.error
      if (isStorageFailureError(err)) {
        engageStoragePassthroughValve("open-failed", err)
      }
      reject(err)
    }
  })
}

async function dbPut(storeName, value) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite")
    tx.objectStore(storeName).put(value)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function dbGet(storeName, key) {
  const db = await openDb()
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly")
    const req = tx.objectStore(storeName).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return result
}

async function dbDelete(storeName, key) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite")
    tx.objectStore(storeName).delete(key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function dbCount(storeName) {
  const db = await openDb()
  const count = await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly")
    const req = tx.objectStore(storeName).count()
    req.onsuccess = () => resolve(req.result || 0)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return count
}

async function dbClear(storeName) {
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite")
    tx.objectStore(storeName).clear()
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  addLog("INFO", "Cache store cleared")
}

async function summarizeChunkStore(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(constants.STORE_CHUNKS, "readonly")
    const store = tx.objectStore(constants.STORE_CHUNKS)
    const index = store.index("createdAt")
    const cursorReq = index.openCursor()
    const oldestFirst = []
    let totalEntries = 0
    let totalBytes = 0

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) return
      const value = cursor.value
      const byteLength = getByteLength(value)
      totalEntries += 1
      totalBytes += byteLength
      oldestFirst.push({
        url: value.url,
        byteLength
      })
      cursor.continue()
    }
    tx.oncomplete = () => resolve({ totalEntries, totalBytes, oldestFirst })
    tx.onerror = () => reject(tx.error)
  })
}

async function evictOldestEntries(db, keysToDelete) {
  if (!keysToDelete.length) return
  await new Promise((resolve, reject) => {
    const tx = db.transaction(constants.STORE_CHUNKS, "readwrite")
    const chunkStore = tx.objectStore(constants.STORE_CHUNKS)
    for (const key of keysToDelete) {
      chunkStore.delete(key)
    }

    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
}

async function cleanupAliasesForTargets(targets) {
  if (!targets.length) return
  const db = await openDb()
  try {
    for (const targetUrl of targets) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(constants.STORE_ALIASES, "readwrite")
        const aliasStore = tx.objectStore(constants.STORE_ALIASES)
        if (!aliasStore.indexNames.contains("targetUrl")) {
          resolve()
          return
        }
        const idx = aliasStore.index("targetUrl")
        const req = idx.openCursor(IDBKeyRange.only(targetUrl))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          cursor.delete()
          cursor.continue()
        }
        req.onerror = () => reject(req.error)
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      })
    }
  } finally {
    db.close()
  }
}

async function evaluateCachePressure() {
  const policy = await computeAdaptiveCachePolicy(false)
  const db = await openDb()
  try {
    const summary = await summarizeChunkStore(db)
    return { policy, summary }
  } finally {
    db.close()
  }
}

async function runEvictionPass(force = false, options = {}) {
  const lane = options.lane || (force ? "hard" : "soft")
  const now = Date.now()
  if (
    !force &&
    lane !== "hard" &&
    typeof ns.isAnyTabEvictionSuppressed === "function" &&
    ns.isAnyTabEvictionSuppressed(now)
  ) {
    return
  }
  if (
    !force &&
    lane === "reconcile" &&
    now - lastEvictionRunAt < constants.CACHE_RECONCILE_INTERVAL_MS
  ) {
    return
  }
  if (!force && lane === "soft" && now - lastEvictionRunAt < constants.CACHE_RECONCILE_INTERVAL_MS) {
    return
  }
  if (evictionInProgress) return
  evictionInProgress = true
  lastEvictionRunAt = now

  try {
    const policy = await computeAdaptiveCachePolicy(false)
    const db = await openDb()
    try {
      const summary = await summarizeChunkStore(db)
      const avgChunkBytes =
        summary.totalEntries > 0
          ? Math.max(64 * 1024, Math.round(summary.totalBytes / summary.totalEntries))
          : constants.CACHE_DEFAULT_AVG_CHUNK_BYTES
      state.cachePolicy.avgChunkBytes = avgChunkBytes

      const pressure =
        typeof ns.evaluateCachePressureRatios === "function"
          ? ns.evaluateCachePressureRatios(summary, policy)
          : {
              overBudget:
                summary.totalBytes > policy.maxBytes ||
                summary.totalEntries > policy.maxEntries,
              overSoftThreshold: true
            }

      if (!force && !pressure.overSoftThreshold && !pressure.overBudget) return

      let overflowEntries = summary.totalEntries - policy.maxEntries
      let overflowBytes = summary.totalBytes - policy.maxBytes
      if (overflowEntries <= 0 && overflowBytes <= 0 && !force) return

      const guardRingSet =
        typeof ns.collectGuardRingProtectedUrls === "function"
          ? ns.collectGuardRingProtectedUrls()
          : new Set()
      const tierASet =
        typeof ns.collectTierAProtectedUrls === "function"
          ? ns.collectTierAProtectedUrls()
          : guardRingSet
      const consumerOnlySet =
        typeof ns.collectConsumerProtectedUrls === "function"
          ? ns.collectConsumerProtectedUrls()
          : new Set()

      const evictionOrder =
        typeof ns.sortEvictionCandidates === "function"
          ? ns.sortEvictionCandidates(summary.oldestFirst, tierASet)
          : summary.oldestFirst

      const keysToDelete = []
      let skippedTierA = 0
      let skippedConsumers = 0
      let reclaimedBytes = 0
      const maxDeletes = Math.max(1, Number(constants.CACHE_MAX_EVICTION_BATCH || 120))
      for (const item of evictionOrder) {
        if (overflowEntries <= 0 && overflowBytes <= 0) break
        if (keysToDelete.length >= maxDeletes) break
        if (
          typeof ns.isUrlGuardRingProtected === "function" &&
          ns.isUrlGuardRingProtected(item.url, tierASet)
        ) {
          skippedTierA += 1
          if (
            consumerOnlySet.size > 0 &&
            ns.isUrlGuardRingProtected(item.url, consumerOnlySet) &&
            !ns.isUrlGuardRingProtected(item.url, guardRingSet)
          ) {
            skippedConsumers += 1
          }
          continue
        }
        keysToDelete.push(item.url)
        overflowEntries -= 1
        overflowBytes -= item.byteLength
        reclaimedBytes += item.byteLength
      }
      if (keysToDelete.length > 0) {
        if (typeof ns.unregisterCacheKeys === "function") {
          ns.unregisterCacheKeys(keysToDelete)
        }
        await evictOldestEntries(db, keysToDelete)
        void cleanupAliasesForTargets(keysToDelete).catch(() => {})
        const guardNote =
          skippedTierA > 0
            ? `, ${skippedTierA} tier-A protected${skippedConsumers > 0 ? ` (${skippedConsumers} consumer-locked)` : ""}`
            : ""
        addLog(
          "INFO",
          `Adaptive cache eviction (${lane}) removed ${keysToDelete.length} chunks (~${(reclaimedBytes / (1024 * 1024)).toFixed(1)} MB${guardNote})`
        )
      }
      if (skippedConsumers > 0 && typeof ns.bumpActivity === "function") {
        ns.bumpActivity("consumerProtectedSkips", skippedConsumers)
      }
      if (overflowEntries > 0 || overflowBytes > 0) {
        if (typeof ns.scheduleEviction === "function") {
          ns.scheduleEviction(true)
        }
      }
    } finally {
      db.close()
    }
  } finally {
    evictionInProgress = false
  }
}

async function safeCacheChunk(url, contentType, bytes) {
  if (!storageSystemOperational) {
    return { ok: false, error: "storage-bypass", bypass: true }
  }
  try {
    return await cacheChunk(url, contentType, bytes)
  } catch (error) {
    if (isStorageFailureError(error)) {
      engageStoragePassthroughValve("write-failed", error)
      return { ok: false, error: "storage-bypass", bypass: true }
    }
    return { ok: false, error: error?.message || "cache-write-failed" }
  }
}

async function cacheChunk(url, contentType, bytes) {
  const normalizedUrl = stripHash(url)
  if (!normalizedUrl) return { ok: false, error: "invalid-url" }
  const cacheKeys = buildCacheKeyVariants(normalizedUrl)
  const primaryKey = cacheKeys[0]
  if (!primaryKey) return { ok: false, error: "missing-primary-key" }
  const now = Date.now()
  const normalizedContentType = contentType || "application/octet-stream"
  const byteLength = getByteLength({ bytes })
  const existing = await dbGet(constants.STORE_CHUNKS, primaryKey).catch(() => null)
  const existingByteLength = getByteLength(existing)
  const existingCreatedAt = Number(existing?.createdAt || 0)
  if (
    existing &&
    existingByteLength > 0 &&
    existingByteLength === byteLength &&
    existing.contentType === normalizedContentType &&
    now - existingCreatedAt < constants.CACHE_DUPLICATE_WRITE_WINDOW_MS
  ) {
    if (typeof ns.scheduleEviction === "function") {
      ns.scheduleEviction(false)
    }
    return { ok: true, stored: false, duplicate: true }
  }
  await dbPut(constants.STORE_CHUNKS, {
    url: primaryKey,
    contentType: normalizedContentType,
    bytes,
    byteLength,
    createdAt: now
  })

  const aliasWrites = []
  const aliasCreatedAt = now
  for (const alias of cacheKeys.slice(1)) {
    if (alias === primaryKey) continue
    aliasWrites.push(
      dbPut(constants.STORE_ALIASES, {
        alias,
        targetUrl: primaryKey,
        createdAt: aliasCreatedAt
      })
    )
  }
  if (isUmpCacheKey(primaryKey)) {
    const bodyHash = getUmpBodyHashFromCacheKey(primaryKey)
    if (bodyHash) {
      const hashAlias = `ump|${bodyHash}`
      if (hashAlias !== primaryKey && !cacheKeys.includes(hashAlias)) {
        aliasWrites.push(
          dbPut(constants.STORE_ALIASES, {
            alias: hashAlias,
            targetUrl: primaryKey,
            createdAt: aliasCreatedAt
          })
        )
      }
    }
  }
  if (aliasWrites.length > 0) {
    await Promise.allSettled(aliasWrites)
  }
  if (typeof ns.scheduleEviction === "function") {
    ns.scheduleEviction(false)
  }
  if (typeof ns.registerCacheKeys === "function") {
    ns.registerCacheKeys(cacheKeys)
  }
  return { ok: true, stored: true, duplicate: false }
}

async function listCachedChunkKeys(limit = 1200) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const keys = []
    const tx = db.transaction(constants.STORE_CHUNKS, "readonly")
    const store = tx.objectStore(constants.STORE_CHUNKS)
    const request = store.openKeyCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        db.close()
        resolve(keys)
        return
      }
      if (typeof cursor.key === "string") keys.push(cursor.key)
      if (keys.length >= limit) {
        db.close()
        resolve(keys)
        return
      }
      cursor.continue()
    }
    request.onerror = () => {
      db.close()
      reject(request.error)
    }
  })
}

async function resolveCachedChunk(url) {
  if (!storageSystemOperational) return null
  try {
    const cacheKeys = buildCacheKeyVariants(url)
    for (const key of cacheKeys) {
      const direct = await dbGet(constants.STORE_CHUNKS, key)
      if (direct?.bytes) return { item: direct, key, via: "direct" }

      const aliasEntry = await dbGet(constants.STORE_ALIASES, key)
      if (!aliasEntry?.targetUrl) continue
      const aliased = await dbGet(constants.STORE_CHUNKS, aliasEntry.targetUrl)
      if (aliased?.bytes) return { item: aliased, key, via: "alias" }
      await dbDelete(constants.STORE_ALIASES, key).catch(() => {})
    }
    return null
  } catch (error) {
    if (isStorageFailureError(error)) {
      engageStoragePassthroughValve("read-failed", error)
    }
    return null
  }
}

async function clearCacheStores() {
  evictionInProgress = false
  lastEvictionRunAt = 0
  storageSystemOperational = true
  storageBypassLogged = false
  state.settings.serveFromCache = true
  await dbClear(constants.STORE_CHUNKS)
  await dbClear(constants.STORE_ALIASES)
  if (typeof ns.clearCacheRegistry === "function") {
    ns.clearCacheRegistry()
  }
  await computeAdaptiveCachePolicy(true)
}

async function getCacheEntryCount() {
  return dbCount(constants.STORE_CHUNKS)
}

ns.cacheChunk = cacheChunk
ns.safeCacheChunk = safeCacheChunk
ns.evaluateCachePressure = evaluateCachePressure
ns.runEvictionPass = runEvictionPass
ns.isStorageSystemOperational = isStorageSystemOperational
ns.engageStoragePassthroughValve = engageStoragePassthroughValve
ns.resolveCachedChunk = resolveCachedChunk
ns.clearCacheStores = clearCacheStores
ns.computeAdaptiveCachePolicy = computeAdaptiveCachePolicy
ns.getCacheEntryCount = getCacheEntryCount
ns.listCachedChunkKeys = listCachedChunkKeys
})()
