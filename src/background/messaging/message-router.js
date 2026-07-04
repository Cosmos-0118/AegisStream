(() => {
var ns = (self.AegisBackground ||= {})
const {
  constants,
  state,
  addLog,
  sanitizeSettings,
  resetStats,
  stripHash,
  extractMessageBytes,
  describeStoreMessageWire,
  formatCrcTelemetry,
  arrayBufferToBase64,
  cacheChunk,
  resolveCachedChunk,
  clearCacheStores,
  maybeLogUmpHealthSummary,
  handleRuntimeMetric,
  bumpActivity,
  bumpLookupMetric,
  recordCacheServeHit,
  recordCacheLookupMiss,
  buildDisplayStats,
  refreshCacheEntryCount,
  enqueueStoreWrite,
  parseAndPrefetchFromPlaylist,
  parsePlaylistContentForTab,
  handleChunkObserved,
  handleForceTeleportAnchor,
  handleScrubbingTrainState,
  handleScrubVelocityPrefetch,
  handleUnifiedSeekState,
  isTabInRapidSeek,
  syncKnownSegmentsToPage,
  maybeRequestPrefetchForTab,
  noteTabPageUrl,
  noteTwitchAuthFromUrl,
  updatePrefetchOutcome,
  noteTabPrefetchFailure,
  noteManifestRefreshFailed,
  computeAdaptiveCachePolicy,
  syncPerformanceGemsFromSettings,
  fetchExtensionResponse,
  pumpResponseBody,
  headersToObject,
  isExpectedAbortError,
  bumpExtensionFetchLifecycle,
  registerActiveExtensionFetch,
  releaseActiveExtensionFetch,
  abortActiveExtensionFetch,
  startExtensionFetchLeakMonitor,
  recordLayoutAssets,
  sanitizeRecordedAssetsFromPage,
  armHeaderHintsForUrl,
  stopExtensionActivityOnTabs,
  broadcastSettingsToTabs,
  buildSettingsPayloadForTabs
} = ns

const playlistDiscoverThrottleAt = new Map()
const layoutRecordLogAt = new Map()

function resolveTabSettingsPayload() {
  return typeof buildSettingsPayloadForTabs === "function"
    ? buildSettingsPayloadForTabs()
    : state.settings
}

function shouldLogLayoutRecord(origin, pathname, reason) {
  const key = `${origin}|${pathname}|${reason}`
  const now = Date.now()
  const last = Number(layoutRecordLogAt.get(key) || 0)
  if (now - last < 2500) return false
  layoutRecordLogAt.set(key, now)
  return true
}

function shouldThrottlePlaylistDiscover(url) {
  const key = stripHash(url)
  if (!key) return true
  const now = Date.now()
  const last = Number(playlistDiscoverThrottleAt.get(key) || 0)
  if (now - last < 4000) return true
  playlistDiscoverThrottleAt.set(key, now)
  if (playlistDiscoverThrottleAt.size > 500) {
    const cutoff = now - 60_000
    for (const [entryKey, ts] of playlistDiscoverThrottleAt.entries()) {
      if (ts < cutoff) playlistDiscoverThrottleAt.delete(entryKey)
    }
  }
  return false
}

function sendExtensionFetchChunk(tabId, requestId, index, bytes) {
  const buffer =
    bytes instanceof ArrayBuffer
      ? bytes
      : bytes?.buffer?.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  if (!buffer || buffer.byteLength === 0) return Promise.resolve()
  return chrome.tabs
    .sendMessage(tabId, {
      type: "AegisStream:ExtensionFetchChunk",
      requestId,
      index,
      bytes: buffer
    })
    .catch(() => {})
}

function sendExtensionFetchEnd(tabId, requestId, payload) {
  return chrome.tabs
    .sendMessage(tabId, {
      type: "AegisStream:ExtensionFetchEnd",
      requestId,
      ...payload
    })
    .catch(() => {})
}

function handleExtensionFetch(message, sendResponse, sender) {
  const tabId = sender?.tab?.id
  const requestId = message.requestId
  const source = message.source || "extension-fetch"

  ;(async () => {
    if (!tabId || !requestId) {
      sendResponse({ ok: false, error: "missing-tab-or-request-id" })
      return
    }

    let metaSent = false
    const controller = new AbortController()
    registerActiveExtensionFetch(requestId, {
      controller,
      startedAt: Date.now(),
      tabId,
      source
    })
    bumpExtensionFetchLifecycle(source, "started")

    try {
      const bodyBytes = extractMessageBytes(message)
      noteTwitchAuthFromUrl(tabId, message.url)
      const response = await fetchExtensionResponse(
        message.url,
        message.method || "GET",
        message.headers || {},
        bodyBytes,
        { tabId, signal: controller.signal, source }
      )

      sendResponse({
        ok: true,
        streaming: true,
        statusCode: response.status,
        headers: headersToObject(response.headers)
      })
      metaSent = true

      await pumpResponseBody(response, async (index, bytes) => {
        await sendExtensionFetchChunk(
          tabId,
          requestId,
          index,
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        )
      })

      await sendExtensionFetchEnd(tabId, requestId, { ok: true })
      bumpExtensionFetchLifecycle(source, "completed")
    } catch (err) {
      if (isExpectedAbortError(err)) {
        bumpExtensionFetchLifecycle(source, "aborted")
        return
      }
      bumpExtensionFetchLifecycle(source, "failed")
      const msg = err?.message || "extension fetch failed"
      if (!metaSent) {
        sendResponse({ ok: false, error: msg })
        return
      }
      await sendExtensionFetchEnd(tabId, requestId, { ok: false, error: msg })
    } finally {
      releaseActiveExtensionFetch(requestId)
    }
  })()
}

function handleExtensionFetchAbort(message) {
  abortActiveExtensionFetch(message.requestId)
}

/** @type {Map<string, Array<{ resolve: Function, timeoutId: ReturnType<typeof setTimeout> | null }>>} */
const pendingWriteResolvers = new Map()
/** @type {Map<string, { resolved: object, expiresAt: number }>} */
const wireResolvedByKey = new Map()
/** @type {Map<string, number>} */
const inflightChunkWriteCounts = new Map()
const WIRE_RESOLVED_TTL_MS = 60_000

function resolveCanonicalCacheKey(lookupUrl) {
  if (typeof ns.resolveRegistryKey === "function") {
    return ns.resolveRegistryKey(lookupUrl)
  }
  if (typeof ns.resolvePrefetchCoalesceKey === "function") {
    return ns.resolvePrefetchCoalesceKey(lookupUrl)
  }
  return stripHash(lookupUrl)
}

function inflightTrackingKey(lookupUrl) {
  return typeof ns.resolvePrefetchCoalesceKey === "function"
    ? ns.resolvePrefetchCoalesceKey(lookupUrl)
    : resolveCanonicalCacheKey(lookupUrl)
}

function removePendingResolver(cacheKey, entry) {
  const list = pendingWriteResolvers.get(cacheKey)
  if (!list) return
  const index = list.indexOf(entry)
  if (index > -1) list.splice(index, 1)
  if (list.length === 0) pendingWriteResolvers.delete(cacheKey)
}

function resolvePendingInflightLookups(url, resolvedItem) {
  const cacheKey = resolveCanonicalCacheKey(url) || stripHash(url)
  if (!cacheKey || !resolvedItem?.item) return
  const resolvers = pendingWriteResolvers.get(cacheKey)
  if (!resolvers?.length) return
  pendingWriteResolvers.delete(cacheKey)
  for (const entry of resolvers) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId)
    if (typeof entry.releaseConsumer === "function") entry.releaseConsumer()
    entry.resolve(resolvedItem)
  }
}

function rejectPendingInflightLookups(url) {
  const cacheKey = resolveCanonicalCacheKey(url) || stripHash(url)
  if (!cacheKey) return
  const resolvers = pendingWriteResolvers.get(cacheKey)
  if (!resolvers?.length) return
  pendingWriteResolvers.delete(cacheKey)
  wireResolvedByKey.delete(cacheKey)
  bumpActivity("collapseCancellations", resolvers.length)
  for (const entry of resolvers) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId)
    if (typeof entry.releaseConsumer === "function") entry.releaseConsumer()
    entry.resolve(null)
  }
}

function getWireResolvedEntry(cacheKey) {
  const cached = wireResolvedByKey.get(cacheKey)
  if (!cached) return null
  if (Date.now() > Number(cached.expiresAt || 0)) {
    wireResolvedByKey.delete(cacheKey)
    return null
  }
  return cached.resolved
}

function resolveInflightWireTransfer(url, bytes, contentType) {
  const normalized = stripHash(url)
  if (!normalized || !bytes || typeof bytes.byteLength !== "number" || bytes.byteLength <= 0) {
    bumpActivity("collapseFallbacks", 1)
    return false
  }
  const cacheKey = resolveCanonicalCacheKey(normalized) || normalized
  const resolved = {
    item: {
      url: normalized,
      bytes,
      contentType: contentType || "application/octet-stream",
      byteLength: bytes.byteLength
    },
    key: cacheKey,
    via: "wire"
  }
  wireResolvedByKey.set(cacheKey, {
    resolved,
    expiresAt: Date.now() + WIRE_RESOLVED_TTL_MS
  })
  resolvePendingInflightLookups(normalized, resolved)
  return true
}

function handleInflightWireResolve(message, sendResponse) {
  const url = stripHash(message.url)
  const bytes = extractMessageBytes(message)
  if (!url || !bytes || bytes.byteLength <= 0) {
    bumpActivity("collapseFallbacks", 1)
    sendResponse({ ok: false, error: "invalid-wire-payload" })
    return
  }
  resolveInflightWireTransfer(url, bytes, message.contentType)
  sendResponse({ ok: true })
}

function registerInflightChunkWrite(url) {
  const cacheKey = resolveCanonicalCacheKey(url) || stripHash(url)
  if (!cacheKey) return
  inflightChunkWriteCounts.set(cacheKey, (inflightChunkWriteCounts.get(cacheKey) || 0) + 1)
}

function releaseInflightChunkWrite(url) {
  const cacheKey = resolveCanonicalCacheKey(url) || stripHash(url)
  if (!cacheKey) return
  const count = inflightChunkWriteCounts.get(cacheKey) || 0
  if (count <= 1) inflightChunkWriteCounts.delete(cacheKey)
  else inflightChunkWriteCounts.set(cacheKey, count - 1)
}

function hasInflightChunkWrite(url) {
  const cacheKey = resolveCanonicalCacheKey(url) || stripHash(url)
  if (!cacheKey) return false
  return (inflightChunkWriteCounts.get(cacheKey) || 0) > 0
}

async function flushPendingInflightLookupsAfterStore(storeUrl) {
  if (typeof resolveCachedChunk !== "function") return
  const resolved = await resolveCachedChunk(storeUrl)
  if (resolved?.item) {
    resolvePendingInflightLookups(storeUrl, resolved)
  }
}

async function resolveCachedChunkWithSegmentHistory(lookupUrl, tabId, manifestIndex, expectedScope = null) {
  let resolved = await resolveCachedChunk(lookupUrl, expectedScope)
  if (resolved?.item || !Number.isFinite(manifestIndex) || !Number.isFinite(tabId)) {
    return resolved
  }
  const tabState = state.playlistByTab.get(tabId)
  const history = tabState?.segmentUrlHistory?.get(manifestIndex)
  if (!Array.isArray(history) || history.length === 0) return resolved

  const lookupNormalized = stripHash(lookupUrl)
  for (const altUrl of history) {
    const normalized = stripHash(altUrl)
    if (!normalized || normalized === lookupNormalized) continue
    const alt = await resolveCachedChunk(normalized, expectedScope)
    if (alt?.item) {
      bumpActivity("segmentHistoryLookupHits", 1)
      if (typeof ns.bridgeCacheAliasesForUrlPair === "function") {
        void ns.bridgeCacheAliasesForUrlPair(normalized, lookupNormalized).catch(() => {})
      }
      return alt
    }
  }
  return resolved
}

async function bridgeStoredChunkRotationAliases(tabId, storeUrl) {
  if (!Number.isFinite(tabId) || !storeUrl) return
  if (typeof ns.bridgeCacheAliasesForUrlPair !== "function") return
  if (typeof ns.resolveSegmentIndexInManifest !== "function") return
  const tabState = state.playlistByTab.get(tabId)
  if (!tabState?.segments?.length) return

  const idx = ns.resolveSegmentIndexInManifest(storeUrl, tabState)
  if (!Number.isFinite(idx)) return

  const normalizedStore = stripHash(storeUrl)
  const history = tabState.segmentUrlHistory?.get(idx)
  if (Array.isArray(history)) {
    for (const altUrl of history) {
      const normalized = stripHash(altUrl)
      if (!normalized || normalized === normalizedStore) continue
      await ns.bridgeCacheAliasesForUrlPair(normalizedStore, normalized).catch(() => {})
    }
  }
  const current = tabState.segments[idx]
  if (current) {
    const currentNorm = stripHash(current)
    if (currentNorm && currentNorm !== normalizedStore) {
      await ns.bridgeCacheAliasesForUrlPair(normalizedStore, currentNorm).catch(() => {})
    }
  }
}

async function awaitInflightChunkWrite(lookupUrl) {
  const cacheKey = resolveCanonicalCacheKey(lookupUrl) || stripHash(lookupUrl)
  if (!cacheKey || !hasInflightChunkWrite(lookupUrl)) return null

  const existing = await resolveCachedChunk(lookupUrl)
  if (existing?.item) return existing

  const maxWaitMs = Number(constants.INFLIGHT_CHUNK_WRITE_WAIT_MS) || 3_000

  const collapsed = await new Promise((resolve) => {
    const entry = {
      resolve: (value) => resolve(value),
      timeoutId: null,
      releaseConsumer: () => {}
    }

    entry.timeoutId = setTimeout(() => {
      removePendingResolver(cacheKey, entry)
      bumpActivity("inflightStoreWaitTimeouts", 1)
      entry.resolve(null)
    }, maxWaitMs)

    if (!pendingWriteResolvers.has(cacheKey)) {
      pendingWriteResolvers.set(cacheKey, [])
    }
    pendingWriteResolvers.get(cacheKey).push(entry)
  })

  if (collapsed?.item) {
    bumpActivity("inflightStoreCollapseHits", 1)
    return collapsed
  }
  return resolveCachedChunk(lookupUrl)
}

async function awaitInflightPrefetchCacheEntry(lookupUrl, tabId = null) {
  const cacheKey = resolveCanonicalCacheKey(lookupUrl) || stripHash(lookupUrl)
  if (!cacheKey) return null

  const inflightKey = inflightTrackingKey(lookupUrl) || cacheKey
  const inflight = state.inflightPrefetches.get(inflightKey)
  if (!inflight) return null
  if (Number.isFinite(tabId) && inflight.tabId !== tabId) return null

  const inflightTtlMs = Number(constants.PREFETCH_INFLIGHT_TTL_MS) || 12_000
  if (Date.now() - Number(inflight.startedAt || 0) > inflightTtlMs) return null

  const existing = await resolveCachedChunk(lookupUrl)
  if (existing?.item) return existing

  const wireResolved = getWireResolvedEntry(cacheKey)
  if (wireResolved?.item) return wireResolved

  const maxWaitMs = Number(constants.CACHE_LOOKUP_COLLAPSE_WAIT_MS) || 8_000

  return new Promise((resolve) => {
    let consumerAttached = false
    const releaseConsumer = () => {
      if (!consumerAttached) return
      consumerAttached = false
      if (typeof ns.releaseInflightConsumer === "function") {
        ns.releaseInflightConsumer(lookupUrl, tabId)
      }
    }

    const entry = {
      resolve: (value) => {
        releaseConsumer()
        resolve(value)
      },
      timeoutId: null,
      releaseConsumer
    }

    if (typeof ns.attachInflightConsumer === "function") {
      ns.attachInflightConsumer(lookupUrl, tabId)
      consumerAttached = true
    }

    entry.timeoutId = setTimeout(() => {
      removePendingResolver(cacheKey, entry)
      bumpActivity("collapseCancellations", 1)
      entry.resolve(null)
    }, maxWaitMs)

    if (!pendingWriteResolvers.has(cacheKey)) {
      pendingWriteResolvers.set(cacheKey, [])
    }
    pendingWriteResolvers.get(cacheKey).push(entry)
  })
}

function handleCacheLookup(message, sendResponse, tabId = null) {
  ;(async () => {
    const method = (message.method || "GET").toUpperCase()
    const hasRange = Boolean(message.hasRange)
    const lookupUrl = stripHash(message.url)
    const tabState = Number.isFinite(tabId) ? state.playlistByTab.get(tabId) : null
    const rapidSeek = isTabInRapidSeek(tabState)
    if (
      method !== "GET" ||
      hasRange ||
      !lookupUrl ||
      !state.settings.enabled ||
      !state.settings.serveFromCache ||
      (typeof ns.isStorageSystemOperational === "function" && !ns.isStorageSystemOperational())
    ) {
      sendResponse({ ok: true, hit: false, skipped: true })
      return
    }

    if (
      lookupUrl &&
      /\/proxy\/oppai\/(kite|dio)\//i.test(lookupUrl) &&
      !/\/EV9fQAQQ/i.test(lookupUrl)
    ) {
      sendResponse({ ok: true, hit: false, skipped: true, reason: "playlist-proxy" })
      return
    }

    bumpLookupMetric("cacheLookups", lookupUrl, 1)
    if (lookupUrl && lookupUrl.startsWith("aegis|")) {
      bumpActivity("lookupKeyInvariantCount", 1)
    } else {
      bumpActivity("lookupKeyRawUrlCount", 1)
    }
    if (typeof ns.recordStreamMetric === "function") {
      ns.recordStreamMetric("hls", "lookups", 1)
    }

    let lookupManifestIndex = null
    if (
      Number.isFinite(tabId) &&
      tabState?.segments?.length &&
      tabState?.signatureToIndex &&
      typeof ns.resolveSegmentIndexInManifest === "function"
    ) {
      lookupManifestIndex = ns.resolveSegmentIndexInManifest(lookupUrl, tabState)
      if (typeof ns.recordLookupMappingCoverage === "function") {
        ns.recordLookupMappingCoverage(tabId, lookupUrl, lookupManifestIndex, {
          source: "cache-lookup"
        })
      } else {
        bumpActivity("lookupMappingChecks", 1)
        bumpActivity(
          typeof lookupManifestIndex === "number"
            ? "lookupMappingResolved"
            : "lookupMappingUnresolved",
          1
        )
      }
    }

    const fp = tabState?.playlistFingerprint
    const expectedScope = fp ? `${fp.pageUrlHash || ""}|${fp.mediaPlaylistPath || ""}` : null
    let resolved = await resolveCachedChunkWithSegmentHistory(
      lookupUrl,
      tabId,
      lookupManifestIndex,
      expectedScope
    )
    if (
      !resolved?.item &&
      tabState?.pendingRotationBridge &&
      typeof tabState.pendingRotationBridge.then === "function"
    ) {
      try {
        await Promise.race([
          tabState.pendingRotationBridge,
          new Promise((resolve) => setTimeout(resolve, 400))
        ])
      } catch {
        // bridge may fail without blocking lookup
      }
      resolved = await resolveCachedChunkWithSegmentHistory(
        lookupUrl,
        tabId,
        lookupManifestIndex,
        expectedScope
      )
    }
    let collapsedFromInflight = false
    if (!resolved?.item) {
      const collapsed = await awaitInflightPrefetchCacheEntry(lookupUrl, tabId)
      if (collapsed?.item) {
        resolved = collapsed
        collapsedFromInflight = true
        bumpActivity("requestCollapseHits", 1)
        if (typeof ns.recordStreamMetric === "function") {
          ns.recordStreamMetric("hls", "collapseHits", 1)
        }
      }
    }
    if (!resolved?.item) {
      const storeCollapsed = await awaitInflightChunkWrite(lookupUrl)
      if (storeCollapsed?.item) {
        resolved = storeCollapsed
        collapsedFromInflight = true
        bumpActivity("requestCollapseHits", 1)
        if (typeof ns.recordStreamMetric === "function") {
          ns.recordStreamMetric("hls", "collapseHits", 1)
        }
      }
    }

    if (!resolved?.item) {
      if (!rapidSeek) {
        recordCacheLookupMiss(lookupUrl)
      }
      sendResponse({ ok: true, hit: false })
      return
    }

    recordCacheServeHit(lookupUrl)
    if (Number.isFinite(tabId) && typeof ns.recordTimelineHeat === "function") {
      const tabState = state.playlistByTab.get(tabId)
      if (tabState && typeof ns.resolveSegmentIndexInManifest === "function") {
        const index =
          typeof lookupManifestIndex === "number"
            ? lookupManifestIndex
            : ns.resolveSegmentIndexInManifest(lookupUrl, tabState)
        if (typeof index === "number") {
          ns.recordTimelineHeat(tabId, index, 0.5)
        }
      }
    }
    if (typeof ns.recordStreamMetric === "function") {
      ns.recordStreamMetric("hls", "hits", 1)
    }
    const hlsHits = ns.metrics?.registry?.hls?.hits || state.stats.cacheHits || 0
    if (hlsHits % 25 === 0) {
      maybeLogUmpHealthSummary()
    }
    if (typeof ns.recordSpeculativeUsed === "function") {
      ns.recordSpeculativeUsed(
        lookupUrl,
        resolved.item.bytes?.byteLength || 0,
        tabId
      )
    }
    const rawBytes = resolved.item.bytes
    const byteLength =
      rawBytes && typeof rawBytes.byteLength === "number" ? rawBytes.byteLength : 0
    if (!byteLength) {
      addLog("ERROR", `Cache hit serialization failed: ${lookupUrl.slice(-60)}`)
      sendResponse({ ok: false, hit: false, error: "serialize-failed" })
      return
    }
    const bytes =
      rawBytes instanceof ArrayBuffer
        ? rawBytes
        : rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength)
    // Base64-encode alongside raw bytes so the relay can fall back when
    // chrome.runtime.sendMessage neuters the ArrayBuffer during IPC.
    let bytesBase64 = null
    try {
      bytesBase64 = arrayBufferToBase64(bytes)
    } catch {
      // Best-effort — raw bytes may still survive IPC.
    }
    const lookupResponse = {
      ok: true,
      hit: true,
      contentType: resolved.item.contentType,
      bytes,
      byteLength
    }
    if (bytesBase64) {
      lookupResponse.bytesBase64 = bytesBase64
    }
    sendResponse(lookupResponse)
  })().catch(() => {
    sendResponse({ ok: false, hit: false })
  })
}

function handleInflightPrefetchQuery(message, sendResponse, tabId) {
  const normalized =
    typeof ns.resolvePrefetchCoalesceKey === "function"
      ? ns.resolvePrefetchCoalesceKey(message.url)
      : stripHash(message.url)
  if (!normalized || !Number.isFinite(tabId)) {
    sendResponse({ ok: false, inflight: false })
    return
  }
  const inflight = state.inflightPrefetches.get(normalized)
  const ttlMs = Number(constants.PREFETCH_INFLIGHT_TTL_MS) || 12_000
  const active =
    Boolean(inflight) &&
    inflight.tabId === tabId &&
    Date.now() - Number(inflight.startedAt || 0) < ttlMs
  sendResponse({
    ok: true,
    inflight: active,
    consumers: Number(inflight?.consumers) || 0,
    abortLocked: (Number(inflight?.consumers) || 0) > 0
  })
}

function handleInflightConsumerMutate(message, tabId) {
  const url = stripHash(message.url)
  const delta = Number(message.delta)
  if (!url || !Number.isFinite(delta) || delta === 0) return
  if (typeof ns.mutateInflightConsumer === "function") {
    ns.mutateInflightConsumer(url, delta, tabId)
  }
}

function handleStoreChunk(message, sendResponse, tabId = null) {
  ;(async () => {
    if (!state.settings.enabled) {
      sendResponse({ ok: false, error: "disabled" })
      return
    }
    const method = (message.method || "GET").toUpperCase()
    const hasRange = Boolean(message.hasRange)
    const status = Number(message.status || 0)
    const storeUrl = stripHash(message.url)
    const captureSource =
      typeof message.captureSource === "string" ? message.captureSource : "unknown"
    const wireType = describeStoreMessageWire(message)
    const bytes = extractMessageBytes(message)
    if (method !== "GET" || hasRange || status === 206) {
      sendResponse({ ok: true, skipped: true })
      return
    }
    const byteLength = bytes && typeof bytes.byteLength === "number" ? bytes.byteLength : -1
    if (!storeUrl || !bytes || byteLength <= 0) {
      addLog(
        "WARN",
        `StoreChunk rejected (invalid payload): source=${captureSource} wire=${wireType} bytes=${byteLength >= 0 ? byteLength : "none"} url=${Boolean(storeUrl)} method=${method} range=${hasRange} status=${status} hadBase64=${typeof message.bytesBase64 === "string"}`
      )
      sendResponse({ ok: false, skipped: true, error: "invalid-payload" })
      return
    }
    registerInflightChunkWrite(storeUrl)
    const tabState = Number.isFinite(tabId) ? state.playlistByTab.get(tabId) : null
    const fp = tabState?.playlistFingerprint
    const expectedScope = fp ? `${fp.pageUrlHash || ""}|${fp.mediaPlaylistPath || ""}` : null

    const writeTask =
      typeof ns.safeCacheChunk === "function"
        ? () => ns.safeCacheChunk(storeUrl, message.contentType, bytes, expectedScope)
        : () => cacheChunk(storeUrl, message.contentType, bytes, expectedScope)
    let storeResult
    try {
      storeResult = await enqueueStoreWrite(writeTask)
    } finally {
      releaseInflightChunkWrite(storeUrl)
    }
    if (!storeResult?.ok) {
      rejectPendingInflightLookups(storeUrl)
      sendResponse({
        ok: false,
        skipped: true,
        error: storeResult?.error || "cache-write-failed",
        storageBypass: storeResult?.bypass === true
      })
      return
    }
    if (!storeResult.stored) {
      if (storeResult.duplicate) {
        await flushPendingInflightLookupsAfterStore(storeUrl)
      }
      sendResponse({ ok: true, duplicate: true })
      return
    }
    await flushPendingInflightLookupsAfterStore(storeUrl)
    if (Number.isFinite(tabId)) {
      void bridgeStoredChunkRotationAliases(tabId, storeUrl).catch(() => {})
    }
    bumpActivity("cachedChunks", 1)
    void refreshCacheEntryCount(true).catch(() => {})
    sendResponse({ ok: true })
  })().catch((e) => {
    addLog("ERROR", `StoreChunk exception: ${e.message}`)
    sendResponse({ ok: false, error: "exception" })
  })
}

function registerMessageRouter() {
  const { wakeBackgroundEngine } = ns
  if (typeof startExtensionFetchLeakMonitor === "function") {
    startExtensionFetchLeakMonitor()
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void wakeBackgroundEngine()
    if (!message?.type) return false
  switch (message.type) {
    case "AegisStream:ExtensionFetch":
      handleExtensionFetch(message, sendResponse, sender)
      return true
    case "AegisStream:ExtensionFetchAbort":
      handleExtensionFetchAbort(message)
      return false
    case "AegisStream:GetSettings":
      ;(async () => {
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, settings: resolveTabSettingsPayload(), stats })
      })().catch(() => {
        sendResponse({ ok: true, settings: resolveTabSettingsPayload(), stats: state.stats })
      })
      return true
    case "AegisStream:GetStats":
      ;(async () => {
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, stats })
      })().catch(() => {
        sendResponse({ ok: true, stats: state.stats })
      })
      return true
    case "AegisStream:ResetStats":
      resetStats()
      addLog("INFO", "Activity stats reset by user")
      ;(async () => {
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, stats })
      })().catch(() => {
        sendResponse({ ok: true, stats: state.stats })
      })
      return true
    case "AegisStream:GetLogs":
      sendResponse({ ok: true, logs: state.logs })
      return true
    case "AegisStream:LivelinessPing": {
      const tabId = sender?.tab?.id
      void wakeBackgroundEngine()
      if (Number.isFinite(tabId)) {
        state.bridgeHeartbeatByTab.set(tabId, Date.now())
        const tabState = state.playlistByTab.get(tabId)
        if (
          message.playing === true &&
          tabState &&
          typeof ns.tabNeedsPlaylistRecovery === "function" &&
          ns.tabNeedsPlaylistRecovery(tabState, { forceAfterIdle: true }) &&
          typeof ns.ensureTabPlaylistRecovery === "function"
        ) {
          void ns.ensureTabPlaylistRecovery(tabId, "playback-resume")
        }
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:BridgeReady": {
      const tabId = sender?.tab?.id
      if (tabId) {
        if (sender?.tab?.url) noteTabPageUrl(tabId, sender.tab.url)
        
        if (message.reason === "startup" || message.reason === "dom-ready" || message.reason === "late-init") {
          state.playlistByTab.delete(tabId)
          state.tabAnchorJumps.delete(tabId)
          const pending = state.pendingPrefetchByTab.get(tabId)
          if (pending?.timerId) clearTimeout(pending.timerId)
          state.pendingPrefetchByTab.delete(tabId)
        }

        const now = Date.now()
        const lastHeartbeat = Number(state.bridgeHeartbeatByTab.get(tabId) || 0)
        state.bridgeHeartbeatByTab.set(tabId, now)
        if (message.reason === "visible" && now - lastHeartbeat < 1500) {
          sendResponse({ ok: true })
          return true
        }
        const tabState = state.playlistByTab.get(tabId)
        const pageUrl = sender?.tab?.url || message.pageUrl || null
        const mediaContext =
          typeof ns.isTabMediaContext !== "function" || ns.isTabMediaContext(tabId, pageUrl)
        if (state.settings.enabled && mediaContext && tabState) {
          const needsRecovery =
            typeof ns.tabNeedsPlaylistRecovery === "function" &&
            ns.tabNeedsPlaylistRecovery(tabState, { forceAfterIdle: true })
          if (needsRecovery && typeof ns.ensureTabPlaylistRecovery === "function") {
            void ns.ensureTabPlaylistRecovery(tabId, message.reason || "bridge-ready", {
              force: tabState.warmRecovery === true
            })
          } else if (tabState.segments?.length) {
            syncKnownSegmentsToPage(tabId, tabState.segments, { reason: message.reason || "bridge-ready" })
            if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
              const reason = String(message.reason || "bridge-ready")
              const recovery =
                reason === "store-recovery" ||
                reason === "extension-update" ||
                reason.startsWith("reinject:") ||
                reason === "visible"
              const start = recovery
                ? Math.max(0, tabState.anchorIndex)
                : tabState.anchorIndex + 1
              maybeRequestPrefetchForTab(tabId, tabState.segments, start, recovery ? reason : "bridge-ready", {
                force: recovery
              })
            }
          }
        }
        if (mediaContext && typeof ns.syncCacheRegistryToTab === "function") {
          void ns.syncCacheRegistryToTab(tabId)
        } else if (mediaContext && typeof ns.rebuildCacheRegistryFromDb === "function") {
          void ns.rebuildCacheRegistryFromDb()
        }
      }
      sendResponse({ ok: true, settings: resolveTabSettingsPayload() })
      return true
    }
    case "AegisStream:ClearLogs":
      state.logs = []
      addLog("INFO", "Logs cleared by user")
      sendResponse({ ok: true })
      return true
    case "AegisStream:UpdateSettings": {
      const wasEnabled = state.settings.enabled !== false
      const wasPrefetchEnabled = state.settings.prefetchEnabled !== false
      state.settings = sanitizeSettings({ ...state.settings, ...(message.payload || {}) })
      addLog(
        "INFO",
        `Settings updated: enabled=${state.settings.enabled}, prefetch=${state.settings.prefetchEnabled}, cache=${state.settings.serveFromCache}, window=${state.settings.prefetchWindow}`
      )
      void computeAdaptiveCachePolicy(true).catch(() => {})
      void syncPerformanceGemsFromSettings().catch(() => {})
      const disabledNow = state.settings.enabled === false
      const prefetchOffNow = state.settings.prefetchEnabled === false
      const shouldStopActivity =
        (wasEnabled && disabledNow) ||
        (wasPrefetchEnabled && prefetchOffNow) ||
        disabledNow
      if (shouldStopActivity) {
        void stopExtensionActivityOnTabs(state.settings, disabledNow ? "disabled" : "prefetch-off")
      } else {
        void broadcastSettingsToTabs(state.settings)
      }
      chrome.storage.local
        .set({ settings: state.settings })
        .then(() => sendResponse({ ok: true, settings: resolveTabSettingsPayload() }))
        .catch((e) => {
          addLog("ERROR", `Failed to persist settings: ${e.message}`)
          sendResponse({ ok: false })
        })
      return true
    }
    case "AegisStream:CacheLookup":
      handleCacheLookup(message, sendResponse, sender?.tab?.id)
      return true
    case "AegisStream:InflightPrefetchQuery":
      handleInflightPrefetchQuery(message, sendResponse, sender?.tab?.id)
      return true
    case "AegisStream:InflightConsumerMutate":
      handleInflightConsumerMutate(message, sender?.tab?.id)
      sendResponse({ ok: true })
      return false
    case "AegisStream:InflightWireResolve":
      handleInflightWireResolve(message, sendResponse)
      return true
    case "AegisStream:StoreChunk":
      handleStoreChunk(message, sendResponse, sender?.tab?.id)
      return true
    case "AegisStream:ClearCache":
      ;(async () => {
        await clearCacheStores()
        state.playlistByTab.clear()
        state.bridgeHeartbeatByTab.clear()
        state.tabPageHostByTab?.clear()
        state.tabPageUrlFingerprintByTab?.clear()
        state.twitchSessionByTab?.clear()
        state.tabAnchorJumps.clear()
        for (const pending of state.pendingPrefetchByTab.values()) {
          if (pending?.timerId) clearTimeout(pending.timerId)
        }
        state.pendingPrefetchByTab.clear()
        state.inflightPrefetches.clear()
        state.failedPrefetches.clear()
        await computeAdaptiveCachePolicy(true).catch(() => {})
        
        if (chrome.browsingData && typeof chrome.browsingData.removeCache === "function") {
          await new Promise((resolve) => {
            chrome.browsingData.remove({ since: 0 }, { cache: true }, resolve)
          }).catch(() => {})
        }

        resetStats()
        await refreshCacheEntryCount(true)
        addLog("INFO", "Cache and stats cleared by user")
        const stats = await buildDisplayStats()
        sendResponse({ ok: true, stats })
      })().catch(() => {
        sendResponse({ ok: false })
      })
      return true
    case "AegisStream:PlaylistDiscovered": {
      const tabId = sender?.tab?.id
      if (sender?.tab?.url) noteTabPageUrl(tabId, sender.tab.url)
      if (tabId && message.url && !shouldThrottlePlaylistDiscover(message.url)) {
        addLog("DEBUG", `Playlist URL discovered in DOM: ${message.url.slice(-80)}`)
        void parseAndPrefetchFromPlaylist(tabId, message.url)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PlaylistContent": {
      const tabId = sender?.tab?.id
      if (sender?.tab?.url) noteTabPageUrl(tabId, sender.tab.url)
      if (tabId && message.url && message.text && state.settings.enabled) {
        addLog(
          "INFO",
          `Playlist content captured from page (${message.text.length} chars): ${message.url.slice(-80)}`
        )
        void parsePlaylistContentForTab(tabId, message.url, message.text, {
          pageUrl: message.pageUrl || null,
          generation: message.generation
        })
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PlaylistRefreshFailed": {
      const tabId = sender?.tab?.id
      if (tabId) {
        noteManifestRefreshFailed(tabId, message.generation, message.status)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:CacheServeHit": {
      if (message.url) {
        recordCacheServeHit(message.url)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:SpeculativeRegister": {
      if (typeof ns.registerSpeculativePrefetch === "function" && message.url) {
        ns.registerSpeculativePrefetch({
          url: message.url,
          tabId: sender?.tab?.id,
          source: message.source || "speculative",
          fromItag: message.fromItag || null,
          toItag: message.toItag || null,
          fromRung: message.fromRung || null,
          toRung: message.toRung || null
        })
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:PrefetchResult":
      ;(async () => {
        const tabId = sender?.tab?.id
        const skipped = message.skipped
        if (
          skipped === "already-inflight" ||
          skipped === "tab-inactive" ||
          skipped === "tab-hidden" ||
          skipped === "stale-queue" ||
          skipped === "aborted" ||
          skipped === "generation-stale"
        ) {
          if (Number.isFinite(tabId)) {
            const tabState = state.playlistByTab.get(tabId)
            const normalized = stripHash(message.url)
            if (tabState && normalized && typeof ns.releasePrefetchDownload === "function") {
              ns.releasePrefetchDownload(tabState, normalized)
            }
          }
          updatePrefetchOutcome(message.url, true)
          sendResponse({ ok: true })
          return
        }
        if (Number.isFinite(tabId)) {
          const tabState = state.playlistByTab.get(tabId)
          if (
            tabState &&
            typeof ns.isCurrentNetworkGeneration === "function" &&
            !ns.isCurrentNetworkGeneration(tabState, message.networkGeneration)
          ) {
            const normalized = stripHash(message.url)
            if (normalized && typeof ns.releasePrefetchDownload === "function") {
              ns.releasePrefetchDownload(tabState, normalized)
            }
            updatePrefetchOutcome(message.url, true)
            sendResponse({ ok: true })
            return
          }
        }
        if (message.success) {
          if (Number.isFinite(tabId)) {
            const tabState = state.playlistByTab.get(tabId)
            const normalized = stripHash(message.url)
            if (tabState && normalized && typeof ns.releasePrefetchDownload === "function") {
              ns.releasePrefetchDownload(tabState, normalized)
            }
          }
          updatePrefetchOutcome(message.url, true, "unknown", { tabId })
          bumpActivity("prefetched", 1)
          if (typeof ns.recordSpeculativeCompleted === "function") {
            ns.recordSpeculativeCompleted(message.url, message.size, true)
          }
          const sizeKB = message.size ? `(${(message.size / 1024).toFixed(1)} KB)` : ""
          sendResponse({ ok: true })
          return
        }

        const lookupUrl = stripHash(message.url)
        if (lookupUrl) {
          const existing = await resolveCachedChunk(lookupUrl).catch(() => null)
          if (existing?.item) {
            updatePrefetchOutcome(message.url, true)
            sendResponse({ ok: true })
            return
          }
        }

        const errorText =
          typeof ns.summarizePrefetchErrorForFsm === "function"
            ? ns.summarizePrefetchErrorForFsm(message)
            : message.errorMessage || message.error || "unknown"
        const transient =
          message.transient === true ||
          /tab-hidden|tab-not-active|runtime|timeout|serialize|message port/i.test(errorText)
        if (typeof ns.recordSpeculativeCompleted === "function") {
          ns.recordSpeculativeCompleted(message.url, 0, false)
        }
        if (Number.isFinite(tabId)) {
          const tabState = state.playlistByTab.get(tabId)
          const normalized = stripHash(message.url)
          if (tabState && normalized && typeof ns.releasePrefetchDownload === "function") {
            ns.releasePrefetchDownload(tabState, normalized)
          }
        }
        const outcome = updatePrefetchOutcome(message.url, false, errorText, { transient })
        if (Number.isFinite(tabId)) {
          noteTabPrefetchFailure(tabId, errorText, {
            authFailure: message.authFailure === true,
            rateLimit: message.rateLimit === true,
            httpStatus: Number(message.status) || 0
          })
        }
        bumpActivity("prefetchFailed", 1)
        const shouldLogFailure =
          outcome.attempts <= 2 ||
          outcome.attempts % 4 === 0 ||
          errorText === "delegate-failed"
        if (shouldLogFailure) {
          const logLine =
            typeof ns.formatPrefetchFailureLogLine === "function"
              ? ns.formatPrefetchFailureLogLine(tabId, message, outcome)
              : `Prefetch failed (attempt ${outcome.attempts}): ${errorText} — ${(message.url || "").slice(-80)}`
          addLog(transient ? "WARN" : "ERROR", logLine)
        }
        sendResponse({ ok: true })
      })().catch(() => {
        sendResponse({ ok: true })
      })
      return true
    case "AegisStream:ChunkObserved": {
      const tabId = sender?.tab?.id
      if (!state.settings.enabled) {
        sendResponse({ ok: true, skipped: true })
        return true
      }
      if (tabId && message.url) {
        void handleChunkObserved(tabId, message.url)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:ForceTeleportAnchor": {
      const tabId = sender?.tab?.id
      if (state.settings.enabled && Number.isFinite(tabId)) {
        handleForceTeleportAnchor(tabId, message.payload || message)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:TabVisibility": {
      const tabId = sender?.tab?.id
      if (Number.isFinite(tabId)) {
        if (message.hidden === true) {
          if (typeof ns.pauseTabPrefetchForVisibility === "function") {
            ns.pauseTabPrefetchForVisibility(tabId, "tab-hidden", {
              playing: message.playing === true
            })
          }
        } else if (typeof ns.resumeTabPrefetchForVisibility === "function") {
          ns.resumeTabPrefetchForVisibility(tabId, "tab-visible")
        }
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:UnifiedSeekState": {
      const tabId = sender?.tab?.id
      if (state.settings.enabled && Number.isFinite(tabId)) {
        handleUnifiedSeekState(tabId, message.wire || message.payload || message)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:ScrubbingTrain": {
      const tabId = sender?.tab?.id
      if (state.settings.enabled && Number.isFinite(tabId)) {
        handleScrubbingTrainState(tabId, message.payload || message)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:ScrubVelocityPrefetch": {
      const tabId = sender?.tab?.id
      if (state.settings.enabled && Number.isFinite(tabId)) {
        handleScrubVelocityPrefetch(tabId, message.payload || message)
      }
      sendResponse({ ok: true })
      return true
    }
    case "AegisStream:RuntimeMetric":
      handleRuntimeMetric(message, sender)
      sendResponse({ ok: true })
      return true
    case "AegisStream:DebugLog":
      addLog(message.level || "DEBUG", `[Page Bridge] ${message.msg}`)
      sendResponse({ ok: true })
      return true
    case "AegisStream:RecordLayoutAssets": {
      ;(async () => {
        if (!state.settings.enabled) {
          sendResponse({ ok: false, error: "disabled" })
          return
        }
        const assets = sanitizeRecordedAssetsFromPage(message.assets)
        const saved = await recordLayoutAssets(message.origin, message.pathname, assets)
        if (saved.length > 0 && shouldLogLayoutRecord(message.origin, message.pathname, message.reason)) {
          addLog(
            "DEBUG",
            `Layout assets recorded (${saved.length}, ${message.reason || "unknown"}) for ${String(message.origin || "").slice(0, 48)}${message.pathname || "/"}`
          )
        }
        sendResponse({ ok: true, count: saved.length })
      })().catch((e) => {
        sendResponse({ ok: false, error: e.message })
      })
      return true
    }
    case "AegisStream:ArmHeaderHints": {
      ;(async () => {
        const result = await armHeaderHintsForUrl(message.targetUrl, message.reason || "hover")
        sendResponse({ ok: result.ok === true, ...result })
      })().catch((e) => {
        sendResponse({ ok: false, error: e.message })
      })
      return true
    }
    default:
      return false
  }
})

}

ns.resolvePendingInflightLookups = resolvePendingInflightLookups
ns.rejectPendingInflightLookups = rejectPendingInflightLookups
ns.resolveInflightWireTransfer = resolveInflightWireTransfer
ns.registerMessageRouter = registerMessageRouter
})()
