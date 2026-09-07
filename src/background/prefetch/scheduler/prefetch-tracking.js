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
      const okState = state.playlistByTab.get(tabId)
      // A segment fetched successfully proves the held segment URLs are still
      // good, whatever the manifest endpoint is doing.
      if (okState) okState.authExpiredPrefetchFailures = 0
      ns.noteTabPrefetchSuccess(tabId)
      if (typeof ns.noteRefreshRecoverySuccess === "function") ns.noteRefreshRecoverySuccess(tabId, state.playlistByTab.get(tabId))

      // Depth's other trigger (prefetch-scheduler.js's all-cached branch) needs
      // the *entire* urgent window already held, which happens at startup and
      // then essentially never again once steady state settles into "exactly
      // one new segment per chunk observed" (batch=1 drip) — the urgent window
      // is never simultaneously fully cached, so depth stopped getting a turn
      // after the first few seconds of every session. Every genuine fetch
      // completion is an equally valid standing-start check instead: it's a
      // no-op unless nothing else is in flight and the buffer is genuinely
      // healthy, both enforced by maybeScheduleDepthFill's own guards.
      //
      // Gated on options.fetched (set only at the one call site where the page
      // actually performed a network fetch) rather than plain `success`: several
      // other call sites report success for skipped/stale-generation/
      // already-cached outcomes where no fetch happened and `inflight` is
      // frequently already gone (released by chunk-observer when the player
      // itself consumes the segment) — those would otherwise resolve to index 0
      // below and schedule a depth pass from the start of the manifest.
      // A depth-fill segment's own completion must not retrigger another depth
      // pass (that's how a chain of ever-deeper passes would happen). The
      // primary signal is the just-released inflight entry's source, but that
      // entry can already be gone by the time this runs (chunk-observer
      // releases it early if the player itself consumes the segment) — when
      // that happens, fall back to "was a depth pass issued very recently on
      // this tab" as a conservative proxy rather than assuming non-depth.
      const depthCooldownMs = Number(constants.PREFETCH_DEPTH_COOLDOWN_MS) || 1_500
      const isDepthFillCompletion = inflight
        ? typeof ns.isDepthFillSource === "function" && ns.isDepthFillSource(inflight.source)
        : Date.now() - Number(okState?.lastDepthFillAt || 0) < depthCooldownMs * 2
      if (options.fetched === true && okState?.segments?.length && typeof ns.maybeScheduleDepthFill === "function" && !isDepthFillCompletion) {
        // Never guess the frontier: resolve strictly against the *current*
        // manifest (a playlist rotation can leave inflight.segmentIndex pointing
        // at the old segments array — the captured index isn't trustworthy
        // enough to fall back to, since a wrong-but-plausible index is more
        // dangerous here than skipping this tick's depth pass entirely).
        const manifestIndex =
          typeof ns.resolveSegmentIndexInManifest === "function"
            ? ns.resolveSegmentIndexInManifest(normalizedUrl, okState)
            : null
        if (Number.isFinite(manifestIndex) && manifestIndex >= 0) {
          const nextIndex = manifestIndex + 1
          const urgentWindow =
            typeof ns.resolveEffectivePrefetchWindow === "function"
              ? ns.resolveEffectivePrefetchWindow(tabId)
              : Number(state.settings?.prefetchWindow) || 0
          // Deferred off the message-handling turn: this runs from the
          // AegisStream:PrefetchResult handler ahead of sendResponse, and a
          // depth pass filters its window with an O(n) indexOf-per-target scan
          // (schedulePrefetch), which shouldn't sit inline on that round trip.
          // Re-resolved against the live map (not the captured `okState`) when
          // the timer fires: upsertPlaylistState always replaces the tabState
          // object wholesale on a playlist refresh rather than mutating it, so
          // a rotation landing in the meantime would otherwise hand a stale
          // segments array back into schedulePrefetch's own upsert call.
          setTimeout(() => {
            const live = state.playlistByTab.get(tabId)
            if (!live || live !== okState || !live.segments?.length) return
            ns.maybeScheduleDepthFill(tabId, live, live.segments, nextIndex, { urgentWindow })
          }, 0)
        }
      }
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
  if (tabState && tabState.refreshState === ns.REFRESH_STATE_AUTH_EXPIRED) {
    tabState.authExpiredPrefetchFailures = Number(tabState.authExpiredPrefetchFailures || 0) + 1
  }
  state.failedPrefetches.set(normalizedUrl, { attempts, retryAfter, lastFailedAt: Date.now(), lastError: String(error || "unknown"), transient })
  return { attempts, retryAfter, transient }
}
})()
