(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog, stripHash, buildCacheKeyVariants } = ns
let evictionInProgress = false
let lastEvictionRunAtByLane = { hard: 0, soft: 0, reconcile: 0 }
let storageSystemOperational = true
let storageBypassLogged = false
let storageRecoveryTimerId = null

/**
 * Two-level in-memory cache index (P6): any key variant or alias -> primary
 * chunk key. A warm lookup is one direct IDB get on the primary key instead
 * of a variant-by-variant chunk + alias chain walk (each of which opens its
 * own transaction).
 */
const MEMORY_KEY_INDEX_MAX = 6_000
const memoryKeyIndex = new Map()

function indexCacheKeys(primaryKey, aliasKeys = []) {
  if (!primaryKey) return
  memoryKeyIndex.set(primaryKey, primaryKey)
  for (const alias of aliasKeys) {
    if (alias) memoryKeyIndex.set(alias, primaryKey)
  }
  if (memoryKeyIndex.size > MEMORY_KEY_INDEX_MAX) {
    const excess = memoryKeyIndex.size - MEMORY_KEY_INDEX_MAX
    let removed = 0
    for (const key of memoryKeyIndex.keys()) {
      memoryKeyIndex.delete(key)
      removed += 1
      if (removed >= excess) break
    }
  }
}

function dropIndexedPrimaryKeys(primaryKeys) {
  const drop = new Set((primaryKeys || []).filter(Boolean))
  if (!drop.size) return
  for (const [key, primary] of memoryKeyIndex.entries()) {
    if (drop.has(primary)) memoryKeyIndex.delete(key)
  }
}

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

function restoreStoragePassthrough(reason = "recovery") {
  if (storageSystemOperational) return
  storageSystemOperational = true
  state.settings.serveFromCache = true
  storageBypassLogged = false
  if (typeof ns.broadcastSettingsToTabs === "function") {
    void ns.broadcastSettingsToTabs(state.settings)
  }
  if (typeof ns.recordDecision === "function") {
    ns.recordDecision("storage", "restore", reason)
  }
  addLog("INFO", `Storage cache passthrough recovered (${reason})`)
}

function scheduleStorageRecovery() {
  if (storageRecoveryTimerId) clearTimeout(storageRecoveryTimerId)
  const recoveryMs = Number(constants.CACHE_PASSTHROUGH_RECOVERY_MS) || 60_000
  storageRecoveryTimerId = setTimeout(() => {
    storageRecoveryTimerId = null
    restoreStoragePassthrough("cooldown")
  }, recoveryMs)
}

function engageStoragePassthroughValve(reason, error) {
  if (!storageSystemOperational) return
  storageSystemOperational = false
  state.settings.serveFromCache = false
  triggerEmergencyCacheEviction()
  scheduleStorageRecovery()
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

  const defaultMaxEntries = constants?.DEFAULT_SETTINGS?.maxEntries || 500
  const configuredMaxEntries = Math.max(50, Number(state.settings?.maxEntries) || defaultMaxEntries)
  const avgChunkBytes = Math.max(
    64 * 1024,
    Number(state.cachePolicy?.avgChunkBytes || constants.CACHE_DEFAULT_AVG_CHUNK_BYTES)
  )

  // Assume a worst-case chunk size (e.g. 1080p chunks at ~5MB) to prevent cache thrashing 
  // when jumping from low quality to high quality.
  const assumedPeakChunkBytes = 5 * 1024 * 1024
  let maxBytes = Math.min(
    constants.CACHE_MAX_BYTES,
    Math.max(
      constants.CACHE_MIN_BYTES,
      Math.round(assumedPeakChunkBytes * configuredMaxEntries * 1.25)
    )
  )

  try {
    if (navigator?.storage?.estimate) {
      const estimate = await navigator.storage.estimate()
      const quota = Number(estimate?.quota || 0)
      if (Number.isFinite(quota) && quota > 0) {
        // The browser already determines a safe `quota` based on the user's free disk space.
        // Instead of arbitrarily throttling to 12% of the quota, we allow the cache to use
        // the user's requested capacity, capped safely below the browser's hard quota limit.
        const safeQuotaLimit = Math.max(0, quota - 100 * 1024 * 1024) // 100MB headroom for extension state
        maxBytes = Math.round(
          Math.max(
            constants.CACHE_MIN_BYTES / 2,
            Math.min(maxBytes, safeQuotaLimit, constants.CACHE_MAX_BYTES)
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
  if (!targets.length) return 0
  const db = await openDb()
  let deleted = 0
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
          deleted += 1
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
  return deleted
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
    now - lastEvictionRunAtByLane.reconcile < constants.CACHE_RECONCILE_INTERVAL_MS
  ) {
    return
  }
  if (!force && lane === "soft" && now - lastEvictionRunAtByLane.soft < constants.CACHE_RECONCILE_INTERVAL_MS) {
    return
  }
  if (evictionInProgress) return
  evictionInProgress = true
  lastEvictionRunAtByLane[lane] = now

  try {
    const policy = await computeAdaptiveCachePolicy(false)
    const db = await openDb()
    try {
      const summary = await summarizeChunkStore(db)
      const ttlSweep = lane === "reconcile" ? await ageSweepCacheEntries(db, policy).catch(() => ({ deleted: 0 })) : { deleted: 0 }
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

      const targetRatio = lane === "reconcile" ? 0.6 : (lane === "soft" ? 0.75 : 0.85)
      const targetBytes = Math.floor(policy.maxBytes * targetRatio)
      const targetEntries = Math.floor(policy.maxEntries * targetRatio)

      let overflowEntries = summary.totalEntries - targetEntries
      let overflowBytes = summary.totalBytes - targetBytes
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
      const evictedItems = []
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
        evictedItems.push({ url: item.url, byteLength: item.byteLength })
        overflowEntries -= 1
        overflowBytes -= item.byteLength
        reclaimedBytes += item.byteLength
      }
      if (ttlSweep.deleted > 0 && typeof ns.scheduleEviction === "function") {
        ns.scheduleEviction(false)
      }
      if (keysToDelete.length > 0) {
        dropIndexedPrimaryKeys(keysToDelete)
        if (typeof ns.unregisterCacheKeys === "function") {
          ns.unregisterCacheKeys(keysToDelete)
        }
        if (typeof ns.recordEvictedChunks === "function") {
          ns.recordEvictedChunks(evictedItems)
        }
        await evictOldestEntries(db, keysToDelete)
        const aliasDeleted = await cleanupAliasesForTargets(keysToDelete).catch(() => 0)
        const guardNote =
          skippedTierA > 0
            ? `, ${skippedTierA} tier-A protected${skippedConsumers > 0 ? ` (${skippedConsumers} consumer-locked)` : ""}`
            : ""
        const aliasNote = aliasDeleted > 0 ? `, ${aliasDeleted} aliases` : ""
        const ttlNote = ttlSweep?.deleted > 0 ? `, ${ttlSweep.deleted} TTL-expired` : ""
        addLog(
          "INFO",
          `Adaptive cache eviction (${lane}) removed ${keysToDelete.length} chunks${aliasNote}${ttlNote} (~${(reclaimedBytes / (1024 * 1024)).toFixed(1)} MB${guardNote})`
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

async function safeCacheChunk(url, contentType, bytes, scope = null) {
  if (!storageSystemOperational) {
    return { ok: false, error: "storage-bypass", bypass: true }
  }
  try {
    return await cacheChunk(url, contentType, bytes, scope)
  } catch (error) {
    if (isStorageFailureError(error)) {
      addLog(
        "WARN",
        `Cache write failed (${error?.name || "storage"}): ${error?.message || "unknown"}. Skipping write, reads remain operational.`
      )
      return { ok: false, error: "storage-bypass", bypass: true }
    }
    return { ok: false, error: error?.message || "cache-write-failed" }
  }
}

async function ageSweepCacheEntries(db, policy) {
  const maxAgeMs = Number(constants.CACHE_TTL_SWEEP_MIN_AGE_MS) || 0
  const maxDeletes = Math.max(1, Number(constants.CACHE_TTL_SWEEP_MAX_DELETE) || 250)
  if (!maxAgeMs || !maxDeletes) return { deleted: 0 }
  const cutoff = Date.now() - maxAgeMs
  let deleted = 0
  await new Promise((resolve, reject) => {
    const tx = db.transaction(constants.STORE_CHUNKS, "readwrite")
    const store = tx.objectStore(constants.STORE_CHUNKS)
    const idx = store.index("createdAt")
    const range = IDBKeyRange.upperBound(cutoff)
    const req = idx.openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor || deleted >= maxDeletes) return
      deleted += 1
      cursor.delete()
      cursor.continue()
    }
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  if (deleted > 0) {
    addLog("INFO", `TTL sweep removed ${deleted} stale cache chunks (> ${Math.round(maxAgeMs / 60000)} min)`)
  }
  return { deleted }
}

async function cacheChunk(url, contentType, bytes, scope = null) {
  const normalizedUrl = stripHash(url)
  if (!normalizedUrl) return { ok: false, error: "invalid-url" }
  const cacheKeys = buildCacheKeyVariants(normalizedUrl)
  const primaryKey = cacheKeys[0]
  if (!primaryKey) return { ok: false, error: "missing-primary-key" }
  const now = Date.now()
  const normalizedContentType = contentType || "application/octet-stream"
  const byteLength = getByteLength({ bytes })
  const dedupKey =
    typeof ns.resolveStoreDedupKey === "function"
      ? ns.resolveStoreDedupKey(normalizedUrl, bytes)
      : null
  if (
    dedupKey &&
    typeof ns.shouldSkipDuplicateStore === "function" &&
    ns.shouldSkipDuplicateStore(dedupKey)
  ) {
    if (typeof ns.bumpActivity === "function") {
      ns.bumpActivity("storeDedupInvariantCrcSkipped", 1)
      ns.bumpActivity("storeDedupSkipped", 1)
    }
    if (typeof ns.scheduleEviction === "function") {
      ns.scheduleEviction(false)
    }
    return { ok: true, stored: false, duplicate: true, dedup: "invariant-crc" }
  }
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
    // Bytes are already on disk under this primary key — keep the index warm.
    indexCacheKeys(primaryKey, cacheKeys.slice(1))
    if (typeof ns.bumpActivity === "function") {
      ns.bumpActivity("storeDedupUrlWindowSkipped", 1)
      ns.bumpActivity("storeDedupSkipped", 1)
    }
    if (typeof ns.scheduleEviction === "function") {
      ns.scheduleEviction(false)
    }
    return { ok: true, stored: false, duplicate: true, dedup: "url-window" }
  }
  await dbPut(constants.STORE_CHUNKS, {
    url: primaryKey,
    contentType: normalizedContentType,
    bytes,
    byteLength,
    scope,
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
  if (aliasWrites.length > 0) {
    await Promise.allSettled(aliasWrites)
  }
  indexCacheKeys(primaryKey, cacheKeys.slice(1))
  if (typeof ns.scheduleEviction === "function") {
    ns.scheduleEviction(false)
  }
  if (typeof ns.registerCacheKeys === "function") {
    ns.registerCacheKeys(cacheKeys)
  }
  if (dedupKey && typeof ns.markStoreDedupKey === "function") {
    ns.markStoreDedupKey(dedupKey)
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

async function bridgeCacheAliasesForUrlPair(oldUrl, newUrl) {
  const oldNormalized = stripHash(oldUrl)
  const newNormalized = stripHash(newUrl)
  if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) return false

  const cached = await resolveCachedChunk(oldNormalized)
  if (!cached?.item || !cached.key) return false

  const primaryKey = cached.key
  const newVariants = buildCacheKeyVariants(newNormalized)
  if (!newVariants.length) return false

  const now = Date.now()
  let wrote = false
  for (const alias of newVariants) {
    if (!alias || alias === primaryKey) continue
    const existing = await dbGet(constants.STORE_ALIASES, alias).catch(() => null)
    if (existing?.targetUrl === primaryKey) {
      indexCacheKeys(primaryKey, [alias])
      continue
    }
    await dbPut(constants.STORE_ALIASES, {
      alias,
      targetUrl: primaryKey,
      createdAt: now
    })
    indexCacheKeys(primaryKey, [alias])
    wrote = true
  }
  return wrote
}

async function bridgePlaylistSegmentUrlAliases(previousSegments, newSegments, options = {}) {
  if (!Array.isArray(previousSegments) || !Array.isArray(newSegments)) return 0
  const end = Math.min(previousSegments.length, newSegments.length)
  let bridged = 0

  const anchor = Number(options.anchorIndex)
  const radius = Number(options.radius) || 0
  const indexOrder = []
  if (Number.isFinite(anchor) && radius > 0) {
    const start = Math.max(0, Math.floor(anchor - radius))
    const stop = Math.min(end, Math.ceil(anchor + radius + 1))
    for (let i = start; i < stop; i += 1) indexOrder.push(i)
    for (let i = 0; i < end; i += 1) {
      if (!indexOrder.includes(i)) indexOrder.push(i)
    }
  } else {
    for (let i = 0; i < end; i += 1) indexOrder.push(i)
  }

  for (const i of indexOrder) {
    const oldUrl = previousSegments[i]
    const newUrl = newSegments[i]
    if (!oldUrl || !newUrl) continue
    if (
      typeof ns.getManifestUrlSignature === "function" &&
      ns.getManifestUrlSignature(oldUrl) === ns.getManifestUrlSignature(newUrl)
    ) {
      continue
    }
    if (await bridgeCacheAliasesForUrlPair(oldUrl, newUrl)) {
      bridged += 1
    }
  }
  return bridged
}

/**
 * Removes alias mappings for the given segment URLs (alias store + memory index).
 * Used on episode switch: a new episode's segment URLs must never resolve to
 * previously-bridged bytes from other content, so any stale/poisoned alias that
 * targets a different primary key is dropped before lookups can serve it.
 */
async function purgeSegmentAliasMappings(segmentUrls) {
  if (!Array.isArray(segmentUrls) || segmentUrls.length === 0) return 0
  let purged = 0
  for (const url of segmentUrls) {
    for (const key of buildCacheKeyVariants(url)) {
      if (!key) continue
      const mappedPrimary = memoryKeyIndex.get(key)
      if (mappedPrimary && mappedPrimary !== key) memoryKeyIndex.delete(key)
      try {
        const aliasEntry = await dbGet(constants.STORE_ALIASES, key)
        if (aliasEntry) {
          await dbDelete(constants.STORE_ALIASES, key)
          purged += 1
        }
      } catch {
        // storage failures here must not block playlist processing
      }
    }
  }
  return purged
}

async function resolveCachedChunk(url, expectedScope = null) {
  if (!storageSystemOperational) return null
  try {
    const cacheKeys = buildCacheKeyVariants(url)
    if (typeof ns.addLog === "function") {
      ns.addLog(
        "DEBUG",
        `resolveCachedChunk start: url=${String(url).slice(-72)} variants=${cacheKeys.length} scope=${expectedScope || "*"} memKeys=${memoryKeyIndex.size} storeOperational=${storageSystemOperational}`
      )
    }

    const probeKeys = []
    const seen = new Set()
    const pushProbe = (value) => {
      if (!value || seen.has(value)) return
      seen.add(value)
      probeKeys.push(value)
    }

    for (const key of cacheKeys) pushProbe(key)
    try {
      const parsed = new URL(stripHash(url))
      if (parsed.search) {
        pushProbe(`${parsed.origin}${parsed.pathname}`)
      }
    } catch {
      // non-URL keys already covered above
    }

    // Fast path: memory index points straight at the primary chunk key.
    for (const key of probeKeys) {
      const primary = memoryKeyIndex.get(key)
      if (!primary) continue
      const indexed = await dbGet(constants.STORE_CHUNKS, primary)
      if (indexed?.bytes) {
        if (expectedScope && indexed.scope && indexed.scope !== expectedScope) {
          continue
        }
        if (typeof ns.addLog === "function") {
          ns.addLog(
            "DEBUG",
            `resolveCachedChunk memory hit: key=${key.slice(-48)} primary=${String(primary).slice(-48)} via=${primary === key ? "direct" : "memory-index"}`
          )
        }
        return { item: indexed, key, via: primary === key ? "direct" : "memory-index" }
      }
      dropIndexedPrimaryKeys([primary])
    }

    for (const key of probeKeys) {
      const direct = await dbGet(constants.STORE_CHUNKS, key)
      if (direct?.bytes) {
        if (!expectedScope || !direct.scope || direct.scope === expectedScope) {
          if (typeof ns.addLog === "function") {
            ns.addLog(
              "DEBUG",
              `resolveCachedChunk direct hit: key=${key.slice(-48)} url=${String(direct.url || key).slice(-48)}`
            )
          }
          indexCacheKeys(direct.url || key)
          return { item: direct, key, via: "direct" }
        }
      }

      const aliasEntry = await dbGet(constants.STORE_ALIASES, key)
      if (!aliasEntry?.targetUrl) continue
      const aliased = await dbGet(constants.STORE_CHUNKS, aliasEntry.targetUrl)
      if (aliased?.bytes && (!expectedScope || !aliased.scope || aliased.scope === expectedScope)) {
        if (typeof ns.addLog === "function") {
          ns.addLog(
            "DEBUG",
            `resolveCachedChunk alias hit: key=${key.slice(-48)} target=${String(aliasEntry.targetUrl).slice(-48)}`
          )
        }
        indexCacheKeys(aliasEntry.targetUrl, [key])
        return { item: aliased, key, via: "alias" }
      }
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
  lastEvictionRunAtByLane = { hard: 0, soft: 0, reconcile: 0 }
  storageSystemOperational = true
  storageBypassLogged = false
  memoryKeyIndex.clear()
  state.settings.serveFromCache = true
  await dbClear(constants.STORE_CHUNKS)
  await dbClear(constants.STORE_ALIASES)
  if (typeof ns.clearCacheRegistry === "function") {
    ns.clearCacheRegistry()
  }
  if (storageRecoveryTimerId) {
    clearTimeout(storageRecoveryTimerId)
    storageRecoveryTimerId = null
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
ns.restoreStoragePassthrough = restoreStoragePassthrough
ns.resolveCachedChunk = resolveCachedChunk
ns.bridgeCacheAliasesForUrlPair = bridgeCacheAliasesForUrlPair
ns.bridgePlaylistSegmentUrlAliases = bridgePlaylistSegmentUrlAliases
ns.purgeSegmentAliasMappings = purgeSegmentAliasMappings
ns.clearCacheStores = clearCacheStores
ns.computeAdaptiveCachePolicy = computeAdaptiveCachePolicy
ns.getCacheEntryCount = getCacheEntryCount
ns.listCachedChunkKeys = listCachedChunkKeys
})()
