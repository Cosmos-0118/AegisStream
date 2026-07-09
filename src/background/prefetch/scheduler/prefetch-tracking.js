(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state } = ns

ns.normalizePrefetchUrl = function normalizePrefetchUrl(url) {
  if (typeof ns.resolvePrefetchCoalesceKey === "function") return ns.resolvePrefetchCoalesceKey(url)
  return typeof ns.stripHash === "function" ? ns.stripHash(url) : url
}

ns.clearPrefetchTrackingForUrls = function clearPrefetchTrackingForUrls(urls) {
  if (!Array.isArray(urls)) return
  for (const url of urls) {
    const normalized = ns.normalizePrefetchUrl(url)
    if (!normalized) continue
    if (typeof ns.tryReleaseInflightEntry === "function") ns.tryReleaseInflightEntry(normalized, { logPreserve: false })
    else state.inflightPrefetches.delete(normalized)
    state.failedPrefetches.delete(normalized)
  }
}

ns.isUrlTrackedAsPrefetch = function isUrlTrackedAsPrefetch(tabId, tabState, chunkUrl) {
  if (!tabState || !chunkUrl) return false
  const normalized = ns.normalizePrefetchUrl(chunkUrl)
  if (!normalized) return false
  const inflight = state.inflightPrefetches.get(normalized)
  if (inflight?.tabId === tabId && Date.now() - Number(inflight.startedAt || 0) < constants.PREFETCH_INFLIGHT_TTL_MS) return true

  if (tabState.prefetchDownloadRegistry instanceof Set) {
    for (const key of tabState.prefetchDownloadRegistry) { if (typeof key === "string" && key.endsWith(`|${normalized}`)) return true }
  }
  if (tabState.activeInflightSegmentIndices instanceof Set && tabState.signatureToIndex && typeof ns.resolveSegmentIndexInManifest === "function") {
    const idx = ns.resolveSegmentIndexInManifest(normalized, tabState)
    if (typeof idx === "number" && tabState.activeInflightSegmentIndices.has(idx)) {
      const segmentUrl = tabState.segments[idx]
      const segmentInflight = segmentUrl ? state.inflightPrefetches.get(ns.normalizePrefetchUrl(segmentUrl)) : null
      if (segmentInflight?.tabId === tabId && Date.now() - Number(segmentInflight.startedAt || 0) < constants.PREFETCH_INFLIGHT_TTL_MS) return true
      tabState.activeInflightSegmentIndices.delete(idx)
    }
  }
  return false
}

ns.segmentIndexHasActivePrefetch = function segmentIndexHasActivePrefetch(tabId, tabState, segmentIndex) {
  if (!tabState?.segments?.length || typeof segmentIndex !== "number") return false
  const idx = Math.max(0, Math.min(Math.round(segmentIndex), tabState.segments.length - 1))
  const normalizedUrl = ns.normalizePrefetchUrl(tabState.segments[idx])
  if (!normalizedUrl) {
    if (tabState.activeInflightSegmentIndices instanceof Set) tabState.activeInflightSegmentIndices.delete(idx)
    return false
  }
  const inflight = state.inflightPrefetches.get(normalizedUrl)
  if (inflight?.tabId === tabId && Date.now() - Number(inflight.startedAt || 0) < constants.PREFETCH_INFLIGHT_TTL_MS) return true
  if (tabState.activeInflightSegmentIndices instanceof Set && tabState.activeInflightSegmentIndices.has(idx)) tabState.activeInflightSegmentIndices.delete(idx)
  if (tabState.prefetchDownloadRegistry instanceof Set) {
    const key = typeof ns.prefetchRegistryKey === "function" ? ns.prefetchRegistryKey(tabState, normalizedUrl) : `${Number(tabState.networkGeneration) || 0}|${normalizedUrl}`
    if (tabState.prefetchDownloadRegistry.has(key)) return true
  }
  return false
}

ns.countPrefetchWindowNeedingFetch = function countPrefetchWindowNeedingFetch(tabId, tabState, startIndex, windowSize) {
  if (!tabState?.segments?.length || typeof startIndex !== "number") return 0
  const end = Math.min(tabState.segments.length, Math.max(0, startIndex) + Math.max(1, windowSize))
  let needed = 0
  for (let idx = Math.max(0, startIndex); idx < end; idx += 1) { if (!ns.segmentIndexHasActivePrefetch(tabId, tabState, idx)) needed += 1 }
  return needed
}

ns.noteInflightSegmentIndices = function noteInflightSegmentIndices(tabState, startIndex, count = 1) {
  if (!tabState || typeof startIndex !== "number") return
  if (!(tabState.activeInflightSegmentIndices instanceof Set)) tabState.activeInflightSegmentIndices = new Set()
  const end = Math.min(tabState.segments?.length || 0, Math.max(0, startIndex) + Math.max(1, count))
  for (let idx = Math.max(0, startIndex); idx < end; idx += 1) tabState.activeInflightSegmentIndices.add(idx)
}

ns.updatePrefetchOutcome = function updatePrefetchOutcome(url, success, error = "unknown", options = {}) {
  const normalizedUrl = ns.normalizePrefetchUrl(url)
  if (!normalizedUrl) return { attempts: 0, retryAfter: 0 }

  const inflight = state.inflightPrefetches.get(normalizedUrl)
  const tabId = options.tabId ?? inflight?.tabId
  if (!success && typeof ns.rejectPendingInflightLookups === "function") ns.rejectPendingInflightLookups(normalizedUrl)
  if (typeof ns.tryReleaseInflightEntry === "function") ns.tryReleaseInflightEntry(normalizedUrl, { logPreserve: false })
  else state.inflightPrefetches.delete(normalizedUrl)

  if (Number.isFinite(tabId)) {
    const tabState = state.playlistByTab.get(tabId)
    if (tabState?.activeInflightSegmentIndices instanceof Set && typeof inflight?.segmentIndex === "number") tabState.activeInflightSegmentIndices.delete(Math.round(inflight.segmentIndex))
  }

  if (success) {
    state.failedPrefetches.delete(normalizedUrl)
    if (Number.isFinite(tabId)) {
      ns.noteTabPrefetchSuccess(tabId)
      if (typeof ns.noteRefreshRecoverySuccess === "function") ns.noteRefreshRecoverySuccess(tabId, state.playlistByTab.get(tabId))
    }
    return { attempts: 0, retryAfter: 0 }
  }

  const previous = state.failedPrefetches.get(normalizedUrl)
  const previousAttempts = typeof previous === "number" ? 1 : Math.max(0, Number(previous?.attempts || 0))
  const attempts = previousAttempts + 1
  const transient = options.transient === true
  const tabState = Number.isFinite(tabId) ? state.playlistByTab.get(tabId) : null
  const backoffMs = transient ? Math.max(400, Math.round(ns.computeFailureBackoffMs(attempts, tabState) * 0.5)) : ns.computeFailureBackoffMs(attempts, tabState)
  const retryAfter = Date.now() + backoffMs
  state.failedPrefetches.set(normalizedUrl, { attempts, retryAfter, lastFailedAt: Date.now(), lastError: String(error || "unknown"), transient })
  return { attempts, retryAfter, transient }
}
})()
