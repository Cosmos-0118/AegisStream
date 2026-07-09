(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

const playlistParsePromises = new Map()
const playlistFetchCompletedAt = new Map()

async function parseAndPrefetchFromPlaylistWork(tabId, normalizedPlaylistUrl, depth) {
  try {
    addLog("DEBUG", `Fetching playlist (depth=${depth}): ${normalizedPlaylistUrl.slice(-100)}`)
    const fetchResult = typeof ns.coalescedFetchPlaylistText === "function" ? await ns.coalescedFetchPlaylistText(tabId, normalizedPlaylistUrl, { depth }) : null
    if (!fetchResult) return

    if (!fetchResult.ok) {
      addLog("WARN", `Playlist fetch failed: ${fetchResult.status ? `HTTP ${fetchResult.status}` : fetchResult.error || "failed"} — ${normalizedPlaylistUrl.slice(-80)}`)
      return
    }
    const contentType = (fetchResult.contentType || "").toLowerCase()
    const text = fetchResult.text || ""
    const isHls = /\.m3u8($|\?)/i.test(normalizedPlaylistUrl) || contentType.includes("mpegurl") || contentType.includes("x-mpegurl") || text.trimStart().startsWith("#EXTM3U")
    const isDash = /\.mpd($|\?)/i.test(normalizedPlaylistUrl) || contentType.includes("dash+xml") || (text.trimStart().startsWith("<?xml") && /<MPD\b/i.test(text))

    if (isHls) {
      const parsed = ns.parseHlsPlaylist(text, normalizedPlaylistUrl)
      if (parsed.kind === "invalid") {
        addLog("DEBUG", `Playlist fetch returned unparseable body (encrypted/obfuscated?) — ${normalizedPlaylistUrl.slice(-60)}`)
        return
      }
      addLog("INFO", `HLS playlist parsed: ${parsed.kind}, ${parsed.variants.length} variants, ${parsed.segments.length} segments`)
      if (parsed.kind === "master") {
        if (typeof ns.bumpActivity === "function") ns.bumpActivity("playlistsDetected", 1)
        if (depth >= 1) return
        if (typeof ns.ingestMasterPlaylist === "function") await ns.ingestMasterPlaylist(tabId, normalizedPlaylistUrl, parsed.variants)
        return
      }
      if (typeof ns.bumpActivity === "function") ns.bumpActivity("playlistsDetected", 1)
      const tabState = ns.upsertPlaylistState(tabId, typeof ns.normalizeSegments === "function" ? ns.normalizeSegments(parsed.segments) : parsed.segments, {
        isLive: parsed.isLive === true, mediaSequence: parsed.mediaSequence, totalDuration: parsed.totalDuration,
        mediaPlaylistUrl: normalizedPlaylistUrl, segmentDurations: parsed.segmentDurations, discontinuityMarkers: parsed.discontinuityMarkers
      })
      if (!tabState?.segments?.length) { addLog("WARN", `HLS media playlist had 0 segments: ${normalizedPlaylistUrl.slice(-60)}`); return }
      ns.rememberMediaPlaylistUrl(tabState, normalizedPlaylistUrl, tabId)
      ns.finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged)
      ns.syncKnownSegmentsToPage(tabId, tabState.segments, ns.buildPlaylistRotationSyncOptions(tabState))
      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        addLog("INFO", `Playlist refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
        ns.maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "playlist-refresh")
      } else { addLog("INFO", "Awaiting player segment request to anchor HLS prefetch (JIT mode)") }
      return
    }

    if (!isDash) { addLog("WARN", `Unknown playlist format for ${normalizedPlaylistUrl.slice(-60)} (content-type: ${contentType})`); return }
    const segments = ns.parseDashPlaylist(text, normalizedPlaylistUrl)
    if (typeof ns.bumpActivity === "function") ns.bumpActivity("playlistsDetected", 1)
    addLog("INFO", `DASH manifest parsed: ${segments.length} segments`)
    const tabState = ns.upsertPlaylistState(tabId, typeof ns.normalizeSegments === "function" ? ns.normalizeSegments(segments) : segments)
    if (!tabState?.segments?.length) return
    ns.rememberMediaPlaylistUrl(tabState, normalizedPlaylistUrl, tabId)
    ns.finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged)
    ns.syncKnownSegmentsToPage(tabId, tabState.segments, ns.buildPlaylistRotationSyncOptions(tabState))
    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      addLog("INFO", `DASH playlist refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
      ns.maybeRequestPrefetchForTab(tabId, tabState.segments, tabState.anchorIndex + 1, "playlist-refresh")
    } else { addLog("INFO", "Awaiting player segment request to anchor DASH prefetch (JIT mode)") }
  } catch (e) { addLog("ERROR", `Playlist error: ${e.message}`) }
}

ns.parseAndPrefetchFromPlaylist = async function parseAndPrefetchFromPlaylist(tabId, playlistUrl, depth = 0) {
  const normalizedPlaylistUrl = typeof ns.stripHash === "function" ? ns.stripHash(playlistUrl) : playlistUrl
  if (!normalizedPlaylistUrl) return
  if ((typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) || (typeof ns.isTwitchMediaUrl === "function" && ns.isTwitchMediaUrl(normalizedPlaylistUrl))) {
    addLog("DEBUG", `Skipping background playlist fetch on Twitch reactive tab ${tabId}: ${normalizedPlaylistUrl.slice(-80)}`); return
  }

  const inflightKey = `${tabId}|${normalizedPlaylistUrl}|${depth}`
  const existingWork = playlistParsePromises.get(inflightKey)
  if (existingWork) return existingWork
  const completedAt = Number(playlistFetchCompletedAt.get(inflightKey) || 0)
  if (Date.now() - completedAt < 5000) return

  const work = parseAndPrefetchFromPlaylistWork(tabId, normalizedPlaylistUrl, depth)
  playlistParsePromises.set(inflightKey, work)
  try { await work } finally { playlistParsePromises.delete(inflightKey); playlistFetchCompletedAt.set(inflightKey, Date.now()) }
}

ns.parsePlaylistContentForTab = async function parsePlaylistContentForTab(tabId, playlistUrl, text, options = {}) {
  if (!state.settings.enabled) return
  if (!text || !tabId) return
  const pageUrl = options.pageUrl || null
  const generation = options.generation
  if (pageUrl && typeof ns.noteTabPageUrl === "function") ns.noteTabPageUrl(tabId, pageUrl)
  const normalizedUrl = (typeof ns.stripHash === "function" ? ns.stripHash(playlistUrl) : playlistUrl) || playlistUrl

  try {
    const isHls = /\.m3u8($|\?)/i.test(normalizedUrl) || text.trimStart().startsWith("#EXTM3U")
    const isDash = /\.mpd($|\?)/i.test(normalizedUrl) || (text.trimStart().startsWith("<?xml") && /<MPD\b/i.test(text))

    if (isHls) {
      const parsed = ns.parseHlsPlaylist(text, normalizedUrl)
      if (parsed.kind === "invalid") {
        addLog("DEBUG", `Captured playlist body is unparseable (encrypted/obfuscated?) — ${normalizedUrl.slice(-60)}`)
        return
      }
      addLog("INFO", `HLS parsed from page capture: ${parsed.kind}, ${parsed.variants.length} variants, ${parsed.segments.length} segments`)
      if (parsed.kind === "master") {
        if (typeof ns.bumpActivity === "function") ns.bumpActivity("playlistsDetected", 1)
        if (typeof ns.ingestMasterPlaylist === "function") await ns.ingestMasterPlaylist(tabId, normalizedUrl, parsed.variants)
        else addLog("INFO", `Master playlist with ${parsed.variants.length} variants — waiting for page to load variant playlists`)
        return
      }
      if (typeof ns.bumpActivity === "function") ns.bumpActivity("playlistsDetected", 1)
      if (!parsed.segments.length) { addLog("WARN", `HLS media playlist had 0 segments: ${normalizedUrl.slice(-60)}`); return }

      const tabStateBefore = state.playlistByTab.get(tabId)
      const normalizedSegments = typeof ns.normalizeSegments === "function" ? ns.normalizeSegments(parsed.segments) : parsed.segments
      const urlsChanged = typeof ns.segmentsUrlsChanged === "function" ? ns.segmentsUrlsChanged(tabStateBefore?.segments, normalizedSegments) : true

      if (typeof ns.shouldAcceptPlaylistCapture === "function" && !ns.shouldAcceptPlaylistCapture(tabStateBefore, generation, urlsChanged)) {
        addLog("DEBUG", `Discarded stale playlist capture on tab ${tabId}${generation ? ` (gen ${generation})` : ""}`); return
      }

      const tabState = ns.upsertPlaylistState(tabId, normalizedSegments, {
        isLive: parsed.isLive === true, mediaSequence: parsed.mediaSequence, totalDuration: parsed.totalDuration,
        mediaPlaylistUrl: normalizedUrl, pageUrl, segmentDurations: parsed.segmentDurations, discontinuityMarkers: parsed.discontinuityMarkers
      })
      if (!tabState?.segments?.length) { addLog("WARN", `HLS media playlist had 0 usable segments: ${normalizedUrl.slice(-60)}`); return }

      ns.rememberMediaPlaylistUrl(tabState, normalizedUrl, tabId)
      ns.finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged, generation)
      ns.syncKnownSegmentsToPage(tabId, tabState.segments, ns.buildPlaylistRotationSyncOptions(tabState))

      if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
        addLog("INFO", `Captured HLS refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
        const forcePrefetch = tabState.anchorRetainedByRefresh === true || Date.now() - Number(tabState.lastQualityVariantSwitchAt || 0) < 3000
        const variantWarm = Date.now() - Number(tabState.lastQualityVariantSwitchAt || 0) < 5000
        const churnWarm = ns.isTabInSeekChurnAggressive(tabState)
        const predicted = typeof tabState.predictedAnchorIndex === "number" ? tabState.predictedAnchorIndex : tabState.anchorIndex
        const adaptiveWindow = typeof ns.resolveAdaptivePrefetchWindow === "function" ? ns.resolveAdaptivePrefetchWindow(tabState) : null
        const hotWindow = typeof ns.getRecentHotIndexWindow === "function" ? ns.getRecentHotIndexWindow(tabState) : null
        const warmFrom = churnWarm
          ? Math.max(tabState.anchorIndex, predicted, hotWindow?.start ?? 0)
          : Math.max(0, tabState.anchorIndex, hotWindow?.start ?? 0)
        const overrideWindow = variantWarm
          ? Math.max(Number(constants.VARIANT_SWITCH_PREFETCH_WINDOW) || 12, Number(constants.SCRUB_SNAP_BACK_RADIUS) || 15, adaptiveWindow || 0, hotWindow?.size || 0)
          : churnWarm
            ? Math.max(
                Number(state.settings.prefetchWindow) || 8,
                Number(constants.SCRUB_SNAP_BACK_RADIUS) || 15,
                adaptiveWindow || 0,
                hotWindow?.size || 0,
                24
              )
            : adaptiveWindow || hotWindow?.size || undefined
        ns.maybeRequestPrefetchForTab(tabId, tabState.segments, warmFrom, variantWarm ? "quality-switch-warm" : churnWarm ? "captured-playlist-churn" : "captured-playlist", {
          force: forcePrefetch || churnWarm,
          prefetchWindowOverride: overrideWindow
        })
      } else {
        const startSeconds = typeof ns.extractStartSecondsFromPageUrl === "function" ? ns.extractStartSecondsFromPageUrl(pageUrl) : null
        const warmWindow = Math.max(3, Number(constants.CAPTURED_PLAYLIST_PRIME_WINDOW) || 5)
        const primeSource = startSeconds !== null ? "captured-playlist-seek-hint" : "captured-playlist-prime"
        if (startSeconds !== null) addLog("INFO", `Page has seek hint t=${startSeconds.toFixed(1)}s; priming buffer window instead of waiting for anchor`)
        else addLog("INFO", "Priming captured HLS buffer window immediately (no anchor yet)")
        ns.maybeRequestPrefetchForTab(tabId, tabState.segments, 0, primeSource, { force: true, prefetchWindowOverride: warmWindow })
      }
      return
    }

    if (!isDash) { addLog("WARN", `Captured playlist content doesn't look like HLS or DASH: ${normalizedUrl.slice(-60)}`); return }
    const segments = ns.parseDashPlaylist(text, normalizedUrl)
    if (typeof ns.bumpActivity === "function") ns.bumpActivity("playlistsDetected", 1)
    addLog("INFO", `DASH parsed from page capture: ${segments.length} segments`)
    if (!segments.length) return

    const tabStateBefore = state.playlistByTab.get(tabId)
    const normalizedSegments = typeof ns.normalizeSegments === "function" ? ns.normalizeSegments(segments) : segments
    const urlsChanged = typeof ns.segmentsUrlsChanged === "function" ? ns.segmentsUrlsChanged(tabStateBefore?.segments, normalizedSegments) : true
    if (typeof ns.shouldAcceptPlaylistCapture === "function" && !ns.shouldAcceptPlaylistCapture(tabStateBefore, generation, urlsChanged)) {
      addLog("DEBUG", `Discarded stale playlist capture on tab ${tabId}${generation ? ` (gen ${generation})` : ""}`); return
    }

    const tabState = ns.upsertPlaylistState(tabId, normalizedSegments)
    if (!tabState?.segments?.length) return
    ns.rememberMediaPlaylistUrl(tabState, normalizedUrl, tabId)
    ns.finishManifestRefreshIfPending(tabId, tabState, tabState.lastUpsertUrlsChanged, generation)
    ns.syncKnownSegmentsToPage(tabId, tabState.segments, ns.buildPlaylistRotationSyncOptions(tabState))

    if (tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
      addLog("INFO", `Captured DASH refresh retained anchor at index ${tabState.anchorIndex}; continuing JIT prefetch`)
      const forcePrefetch = tabState.anchorRetainedByRefresh === true || Date.now() - Number(tabState.lastQualityVariantSwitchAt || 0) < 3000
      const variantWarm = Date.now() - Number(tabState.lastQualityVariantSwitchAt || 0) < 5000
      const churnWarm = ns.isTabInSeekChurnAggressive(tabState)
      const warmFrom = churnWarm ? Math.max(tabState.anchorIndex, typeof tabState.predictedAnchorIndex === "number" ? tabState.predictedAnchorIndex : tabState.anchorIndex) : Math.max(0, tabState.anchorIndex)
      const adaptiveWindow = typeof ns.resolveAdaptivePrefetchWindow === "function" ? ns.resolveAdaptivePrefetchWindow(tabState) : null
      const hotWindow = typeof ns.getRecentHotIndexWindow === "function" ? ns.getRecentHotIndexWindow(tabState) : null
      ns.maybeRequestPrefetchForTab(tabId, tabState.segments, warmFrom, variantWarm ? "quality-switch-warm" : churnWarm ? "captured-playlist-churn" : "captured-playlist", {
        force: forcePrefetch || churnWarm,
        prefetchWindowOverride: variantWarm ? Math.max(Number(constants.VARIANT_SWITCH_PREFETCH_WINDOW) || 12, Number(constants.SCRUB_SNAP_BACK_RADIUS) || 15, adaptiveWindow || 0, hotWindow?.size || 0) : churnWarm ? Math.max(Number(state.settings.prefetchWindow) || 8, Number(constants.SCRUB_SNAP_BACK_RADIUS) || 15, adaptiveWindow || 0, hotWindow?.size || 0, 24) : adaptiveWindow || hotWindow?.size || undefined
      })
    } else {
      addLog("INFO", "Priming captured DASH buffer window immediately (no anchor yet)")
      ns.maybeRequestPrefetchForTab(tabId, tabState.segments, 0, "captured-playlist-prime", { force: true, prefetchWindowOverride: Math.max(3, Number(constants.CAPTURED_PLAYLIST_PRIME_WINDOW) || 5) })
    }
  } catch (e) { addLog("ERROR", `Error parsing captured playlist: ${e.message}`) }
}
})()
