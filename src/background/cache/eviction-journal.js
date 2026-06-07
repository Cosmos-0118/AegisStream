(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog, stripHash, buildCacheKeyVariants, resolveSegmentIndexInManifest } =
  ns

const JOURNAL_TTL_MS = Number(constants.CACHE_EVICTION_JOURNAL_TTL_MS) || 10 * 60 * 1000
const MAX_JOURNAL_ENTRIES = Number(constants.CACHE_EVICTION_JOURNAL_MAX_ENTRIES) || 800
const STORE_DEDUP_TTL_MS =
  Number(constants.CACHE_STORE_INVARIANT_CRC_DEDUP_MS) ||
  Number(constants.CACHE_DUPLICATE_WRITE_WINDOW_MS) ||
  20_000
const RECENT_EVICTION_LOG_DEDUPE_MS = 3_000

/** url variant → eviction record (shared object) */
const evictionJournal = new Map()
/** `${invariantKey}|${crc}|${byteLength}` → storedAt */
const storeDedupByInvariantCrc = new Map()
const recentEvictedMissLogAt = new Map()

function formatSignedDistance(signedDistance) {
  if (typeof signedDistance !== "number" || !Number.isFinite(signedDistance)) return "unknown"
  if (signedDistance >= 0) return `+${signedDistance}`
  return String(signedDistance)
}

function resolvePlaybackDistanceForUrl(url) {
  let best = {
    manifestMapped: false,
    signedDistance: null,
    segmentIndex: null,
    anchorIndex: null
  }
  for (const tabState of state.playlistByTab.values()) {
    if (!tabState?.segments?.length || typeof tabState.anchorIndex !== "number") continue
    const index = resolveSegmentIndexInManifest(url, tabState)
    if (typeof index !== "number") continue
    const signedDistance = index - tabState.anchorIndex
    if (
      !best.manifestMapped ||
      Math.abs(signedDistance) < Math.abs(best.signedDistance)
    ) {
      best = {
        manifestMapped: true,
        signedDistance,
        segmentIndex: index,
        anchorIndex: tabState.anchorIndex
      }
    }
  }
  return best
}

function journalLookupKeys(url) {
  const keys = new Set()
  const normalized = stripHash(url)
  if (!normalized) return keys
  keys.add(normalized)
  for (const variant of buildCacheKeyVariants(normalized)) {
    keys.add(variant)
  }
  if (typeof ns.buildMediaInvariantKey === "function") {
    const invariant = ns.buildMediaInvariantKey(normalized)
    if (invariant) keys.add(invariant)
  }
  return keys
}

function pruneJournal(now = Date.now()) {
  const cutoff = now - JOURNAL_TTL_MS
  for (const [key, record] of evictionJournal.entries()) {
    if (!record?.evictedAt || record.evictedAt < cutoff) {
      evictionJournal.delete(key)
    }
  }
  if (evictionJournal.size <= MAX_JOURNAL_ENTRIES) return
  const ranked = [...evictionJournal.entries()].sort(
    (a, b) => Number(a[1]?.evictedAt || 0) - Number(b[1]?.evictedAt || 0)
  )
  const overflow = ranked.length - MAX_JOURNAL_ENTRIES
  for (let i = 0; i < overflow; i += 1) {
    evictionJournal.delete(ranked[i][0])
  }
}

function pruneStoreDedup(now = Date.now()) {
  const cutoff = now - STORE_DEDUP_TTL_MS
  for (const [key, storedAt] of storeDedupByInvariantCrc.entries()) {
    if (storedAt < cutoff) storeDedupByInvariantCrc.delete(key)
  }
}

function pruneRecentEvictedMissLog(now = Date.now()) {
  const cutoff = now - RECENT_EVICTION_LOG_DEDUPE_MS * 4
  for (const [key, ts] of recentEvictedMissLogAt.entries()) {
    if (ts < cutoff) recentEvictedMissLogAt.delete(key)
  }
}

function shouldLogRecentEvictedMiss(key) {
  pruneRecentEvictedMissLog()
  const now = Date.now()
  const last = recentEvictedMissLogAt.get(key) || 0
  if (now - last < RECENT_EVICTION_LOG_DEDUPE_MS) return false
  recentEvictedMissLogAt.set(key, now)
  return true
}

function lookupEvictionRecord(url) {
  pruneJournal()
  for (const key of journalLookupKeys(url)) {
    const record = evictionJournal.get(key)
    if (record) return record
  }
  return null
}

function recordEvictedChunks(items) {
  if (!Array.isArray(items) || items.length === 0) return
  const now = Date.now()
  const protectedSet =
    typeof ns.collectGuardRingProtectedUrls === "function"
      ? ns.collectGuardRingProtectedUrls()
      : new Set()

  for (const item of items) {
    if (!item?.url) continue
    const normalized = stripHash(item.url)
    if (!normalized) continue
    const dist = resolvePlaybackDistanceForUrl(item.url)
    const guardRingProtected =
      typeof ns.isUrlGuardRingProtected === "function" &&
      ns.isUrlGuardRingProtected(item.url, protectedSet)
    const invariantKey =
      typeof ns.buildMediaInvariantKey === "function"
        ? ns.buildMediaInvariantKey(normalized)
        : null
    const entry = {
      primaryKey: item.url,
      invariantKey,
      evictedAt: now,
      byteLength: Number(item.byteLength) || 0,
      crc: item.crc || null,
      signedDistance: dist.signedDistance,
      manifestMapped: dist.manifestMapped,
      guardRingProtected: !!guardRingProtected
    }
    for (const key of journalLookupKeys(item.url)) {
      evictionJournal.set(key, entry)
    }
    if (!dist.manifestMapped && typeof ns.bumpActivity === "function") {
      ns.bumpActivity("evictedWithoutManifestMap", 1)
    }
  }

  pruneJournal(now)
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity("cacheChunksEvicted", items.length)
  }
}

function noteRecentlyEvictedMiss(url) {
  const record = lookupEvictionRecord(url)
  if (!record) {
    if (typeof ns.bumpActivity === "function") {
      ns.bumpActivity("cacheMissNeverStored", 1)
    }
    return null
  }

  const ageMs = Math.max(0, Date.now() - Number(record.evictedAt || 0))
  const ageSec = Math.round(ageMs / 1000)
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity("recentlyEvictedMisses", 1)
    if (!record.manifestMapped) {
      ns.bumpActivity("evictedMissUnmapped", 1)
    }
  }

  const keyLabel = record.invariantKey || record.primaryKey || url
  if (shouldLogRecentEvictedMiss(keyLabel)) {
    const sizeMb =
      record.byteLength > 0 ? (record.byteLength / (1024 * 1024)).toFixed(1) : "?"
    const keyShort =
      typeof keyLabel === "string" && keyLabel.length > 96
        ? keyLabel.slice(-72)
        : keyLabel
    addLog(
      "DEBUG",
      `MISS recently_evicted key=${keyShort} evicted=${ageSec}s ago size=${sizeMb}MB distance=${formatSignedDistance(record.signedDistance)} manifestMapped=${record.manifestMapped}`
    )
  }

  return {
    recentlyEvicted: true,
    evictedSecondsAgo: ageSec,
    byteLength: record.byteLength,
    signedDistance: record.signedDistance,
    manifestMapped: record.manifestMapped,
    invariantKey: record.invariantKey
  }
}

function resolveStoreDedupKey(url, bytes) {
  const normalized = stripHash(url)
  if (!normalized || bytes == null) return null
  const invariant =
    (typeof ns.buildMediaInvariantKey === "function" &&
      ns.buildMediaInvariantKey(normalized)) ||
    normalized
  const fp =
    typeof ns.crc32Fingerprint === "function" ? ns.crc32Fingerprint(bytes) : null
  if (!fp?.crc) return null
  return `${invariant}|${fp.crc}|${fp.byteLength}`
}

function shouldSkipDuplicateStore(dedupKey) {
  if (!dedupKey) return false
  pruneStoreDedup()
  const storedAt = storeDedupByInvariantCrc.get(dedupKey)
  return typeof storedAt === "number" && Date.now() - storedAt < STORE_DEDUP_TTL_MS
}

function markStoreDedupKey(dedupKey) {
  if (!dedupKey) return
  pruneStoreDedup()
  storeDedupByInvariantCrc.set(dedupKey, Date.now())
}

function getEvictThenMissSummary() {
  const windowTotals =
    typeof ns.sumWindowCounters === "function" ? ns.sumWindowCounters() : {}
  const recentlyEvictedMisses = Math.max(
    windowTotals.recentlyEvictedMisses || 0,
    Number(state.stats.recentlyEvictedMisses) || 0
  )
  const cacheMissNeverStored = Math.max(
    windowTotals.cacheMissNeverStored || 0,
    Number(state.stats.cacheMissNeverStored) || 0
  )
  const classifiedMisses = recentlyEvictedMisses + cacheMissNeverStored
  const beltLookupRecentlyEvictedMisses = Math.max(
    windowTotals.beltLookupRecentlyEvictedMisses || 0,
    Number(state.stats.beltLookupRecentlyEvictedMisses) || 0
  )
  const beltLookupMissNeverStored = Math.max(
    windowTotals.beltLookupMissNeverStored || 0,
    Number(state.stats.beltLookupMissNeverStored) || 0
  )
  const beltClassified = beltLookupRecentlyEvictedMisses + beltLookupMissNeverStored
  return {
    recentlyEvictedMisses,
    cacheMissNeverStored,
    evictedMissUnmapped: Math.max(
      windowTotals.evictedMissUnmapped || 0,
      Number(state.stats.evictedMissUnmapped) || 0
    ),
    evictedWithoutManifestMap: Math.max(
      windowTotals.evictedWithoutManifestMap || 0,
      Number(state.stats.evictedWithoutManifestMap) || 0
    ),
    storeDedupSkipped: Math.max(
      windowTotals.storeDedupSkipped || 0,
      Number(state.stats.storeDedupSkipped) || 0
    ),
    storeDedupInvariantCrcSkipped: Math.max(
      windowTotals.storeDedupInvariantCrcSkipped || 0,
      Number(state.stats.storeDedupInvariantCrcSkipped) || 0
    ),
    storeDedupUrlWindowSkipped: Math.max(
      windowTotals.storeDedupUrlWindowSkipped || 0,
      Number(state.stats.storeDedupUrlWindowSkipped) || 0
    ),
    cacheChunksEvicted: Math.max(
      windowTotals.cacheChunksEvicted || 0,
      Number(state.stats.cacheChunksEvicted) || 0
    ),
    beltLookupMisses: Math.max(
      windowTotals.beltLookupMisses || 0,
      Number(state.stats.beltLookupMisses) || 0
    ),
    beltLookupTimeouts: Math.max(
      windowTotals.beltLookupTimeouts || 0,
      Number(state.stats.beltLookupTimeouts) || 0
    ),
    beltLookupRecentlyEvictedMisses,
    beltLookupMissNeverStored,
    beltLookupRecentlyEvictedMissRatePercent:
      beltClassified > 0
        ? Math.round((beltLookupRecentlyEvictedMisses / beltClassified) * 100)
        : 0,
    recentlyEvictedMissRatePercent:
      classifiedMisses > 0
        ? Math.round((recentlyEvictedMisses / classifiedMisses) * 100)
        : 0,
    journalEntries: evictionJournal.size
  }
}

function resetEvictionJournal() {
  evictionJournal.clear()
  storeDedupByInvariantCrc.clear()
  recentEvictedMissLogAt.clear()
}

ns.recordEvictedChunks = recordEvictedChunks
ns.noteRecentlyEvictedMiss = noteRecentlyEvictedMiss
ns.resolvePlaybackDistanceForUrl = resolvePlaybackDistanceForUrl
ns.resolveStoreDedupKey = resolveStoreDedupKey
ns.shouldSkipDuplicateStore = shouldSkipDuplicateStore
ns.markStoreDedupKey = markStoreDedupKey
ns.getEvictThenMissSummary = getEvictThenMissSummary
ns.resetEvictionJournal = resetEvictionJournal
})()
