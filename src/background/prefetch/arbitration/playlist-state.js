(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

ns.segmentsUrlsChanged = function segmentsUrlsChanged(previousSegments, nextSegments) {
  if (!Array.isArray(previousSegments) || !Array.isArray(nextSegments)) return true
  if (previousSegments.length !== nextSegments.length) return true
  return nextSegments.some((url, i) => url !== previousSegments[i])
}

ns.mergeSegmentUrlHistory = function mergeSegmentUrlHistory(previousHistory, previousSegments, newSegments, anchorIndex, offset = 0) {
  const history = new Map()
  const prevHist = previousHistory instanceof Map ? previousHistory : new Map()
  if (!Array.isArray(previousSegments) || !Array.isArray(newSegments)) return prevHist
  const maxDepth = Number(constants.SEGMENT_URL_HISTORY_DEPTH) || 4

  for (let i = 0; i < newSegments.length; i += 1) {
    const oldIdx = i + offset
    const oldUrl = oldIdx >= 0 && oldIdx < previousSegments.length ? previousSegments[oldIdx] : undefined
    const newUrl = newSegments[i]
    if (!oldUrl && !newUrl) continue
    const list = [...(prevHist.get(oldIdx) || [])]
    if (oldUrl && oldUrl !== newUrl) {
      const oldNorm = typeof ns.stripHash === "function" ? ns.stripHash(oldUrl) : oldUrl
      if (oldNorm && !list.includes(oldNorm)) list.push(oldNorm)
    }
    if (newUrl) {
      const newNorm = typeof ns.stripHash === "function" ? ns.stripHash(newUrl) : newUrl
      if (newNorm) { history.set(i, [newNorm, ...list.filter((e) => e !== newNorm)].slice(0, maxDepth)); continue }
    }
    history.set(i, list.slice(0, maxDepth))
  }
  return history
}

function logEpisodeSwitchPlaylistDiagnostic(tabId, previous, meta, mediaPlaylistPath) {
  const oldPlaylist = typeof ns.formatPlaylistUrlTail === "function" ? ns.formatPlaylistUrlTail(previous?.mediaPlaylistUrl) : "(none)"
  const newFromMeta = meta?.mediaPlaylistUrl ? (typeof ns.stripHash === "function" ? ns.stripHash(meta.mediaPlaylistUrl) || meta.mediaPlaylistUrl : meta.mediaPlaylistUrl) : null
  const newPlaylist = newFromMeta ? (typeof ns.formatPlaylistUrlTail === "function" ? ns.formatPlaylistUrlTail(newFromMeta) : "(truncated)")
    : mediaPlaylistPath ? `(path only: ${mediaPlaylistPath})` : "(awaiting capture)"
  const refreshTargetUrl = newFromMeta || previous?.mediaPlaylistUrl || null
  const refreshTarget = typeof ns.formatPlaylistUrlTail === "function" ? ns.formatPlaylistUrlTail(refreshTargetUrl) : "(truncated)"
  const staleRisk = newFromMeta && previous?.mediaPlaylistUrl && (typeof ns.stripHash === "function" ? ns.stripHash(previous.mediaPlaylistUrl) !== ns.stripHash(newFromMeta) : previous.mediaPlaylistUrl !== newFromMeta) ? "no" : !newFromMeta && previous?.mediaPlaylistUrl ? "yes-until-capture" : "n/a"
  addLog("INFO", `Episode switch playlist (tab ${tabId}): old=${oldPlaylist}, new=${newPlaylist}, refreshTarget=${refreshTarget}, staleRefreshRisk=${staleRisk}`)
}

ns.upsertPlaylistState = function upsertPlaylistState(tabId, normalizedSegments, meta = {}) {
  if (!Array.isArray(normalizedSegments) || normalizedSegments.length === 0) return null
  const previous = state.playlistByTab.get(tabId)
  const { signatures: manifestSignatures, signatureToIndex } = ns.buildManifestSequenceIndex(normalizedSegments)
  const indexQuality = typeof ns.analyzeManifestIndexQuality === "function" ? ns.analyzeManifestIndexQuality(normalizedSegments, signatureToIndex) : null

  let manifestIndexHost = null
  try { const sampleUrl = normalizedSegments[0] || meta.mediaPlaylistUrl || null; if (sampleUrl) manifestIndexHost = new URL(sampleUrl).hostname } catch { manifestIndexHost = null }

  const mediaPlaylistPath = meta.mediaPlaylistPath || (meta.mediaPlaylistUrl ? ns.getManifestUrlSignature(meta.mediaPlaylistUrl) : null) || (previous?.mediaPlaylistUrl ? ns.getManifestUrlSignature(previous.mediaPlaylistUrl) : null)
  const pageUrlForFingerprint = meta.pageUrl || (typeof ns.getTabPageUrlFingerprint === "function" ? ns.getTabPageUrlFingerprint(tabId) : null) || null
  const playlistFingerprint = ns.buildPlaylistFingerprint({ segments: normalizedSegments, mediaPlaylistPath, mediaSequence: meta.mediaSequence, totalDuration: meta.totalDuration, pageUrl: pageUrlForFingerprint })
  const fingerprintAssessment = ns.scorePlaylistFingerprintChange(previous?.playlistFingerprint, playlistFingerprint, { isLive: meta.isLive === true || previous?.isLive === true })
  const contentChangedByFingerprint = fingerprintAssessment.contentChanged
  const fingerprintReason = fingerprintAssessment.fingerprintReason
  const fingerprintScore = fingerprintAssessment.score
  const pageUnchanged = fingerprintAssessment.pageChanged !== true

  const segmentCountChanged = !previous?.segments || previous.segments.length !== normalizedSegments.length
  const urlsChanged = !previous?.segments || previous.segments.length !== normalizedSegments.length || normalizedSegments.some((url, i) => url !== previous.segments[i])
  if (indexQuality && typeof ns.recordManifestIndexQuality === "function") ns.recordManifestIndexQuality(tabId, indexQuality, { host: manifestIndexHost, urlsChanged })

  const durationsForGeometry = Array.isArray(meta.segmentDurations) && meta.segmentDurations.length ? meta.segmentDurations : previous?.segmentDurations
  const durationGeometryHash = typeof ns.buildDurationGeometryHash === "function" ? ns.buildDurationGeometryHash(durationsForGeometry, normalizedSegments.length) : null
  const durationGeometryMatches = Boolean(previous?.durationGeometryHash) && Boolean(durationGeometryHash) && previous.durationGeometryHash === durationGeometryHash
  const timelineGeometryUnchanged = !segmentCountChanged && pageUnchanged && durationGeometryMatches

  if (durationGeometryMatches && !pageUnchanged && urlsChanged) addLog("DEBUG", `Duration geometry matches previous playlist but page identity changed — not classifying as token refresh (tab ${tabId})`)

  const structureChanged = timelineGeometryUnchanged ? false
    : !previous?.segments || previous.segments.length !== normalizedSegments.length || normalizedSegments.some((url, i) => ns.getManifestUrlSignature(url) !== ns.getManifestUrlSignature(previous.segments[i]))
  const tokensRefreshed = urlsChanged && !structureChanged && !contentChangedByFingerprint
  const playlistChanged = structureChanged || contentChangedByFingerprint
  const pageNavigationNewPlayback = fingerprintAssessment.pageChanged === true && urlsChanged
  const episodeChangedByFingerprint = pageNavigationNewPlayback || (urlsChanged && !structureChanged && contentChangedByFingerprint)
  const rapidPlaylistRecapture = Number(previous?.playlistRefreshedAt || 0) > 0 && Date.now() - Number(previous.playlistRefreshedAt) < 1_500 && !segmentCountChanged && urlsChanged && pageUnchanged
  const isRoutinePlaylistRefresh = rapidPlaylistRecapture || (urlsChanged && !segmentCountChanged && !episodeChangedByFingerprint && pageUnchanged && (timelineGeometryUnchanged || (!contentChangedByFingerprint && !structureChanged)))

  const structuralHash = ns.buildStructuralPlaylistHash({ segmentDurations: meta.segmentDurations ?? previous?.segmentDurations, segments: normalizedSegments, discontinuityMarkers: meta.discontinuityMarkers ?? previous?.discontinuityMarkers ?? null, isLive: meta.isLive === true || previous?.isLive === true, segmentCount: normalizedSegments.length })

  const incomingRungLabel = meta.mediaPlaylistUrl && (meta.playlistMatrix || previous?.playlistMatrix) && typeof ns.resolveRungLabelForMediaUrl === "function" ? ns.resolveRungLabelForMediaUrl(meta.playlistMatrix || previous.playlistMatrix, meta.mediaPlaylistUrl) : null
  const matrixForRung = meta.playlistMatrix || previous?.playlistMatrix || null
  let fsmRungLabel = incomingRungLabel || meta.activeRungLabel || previous?.activeRungLabel || null
  if (incomingRungLabel && previous?.activeRungLabel && incomingRungLabel !== previous.activeRungLabel && typeof ns.shouldSkipSpeculativeDowngradeRung === "function" && ns.shouldSkipSpeculativeDowngradeRung(previous, matrixForRung, previous.activeRungLabel, incomingRungLabel)) fsmRungLabel = previous.activeRungLabel

  const playbackTransition = ns.determinePlaybackTransition(previous, { structuralHash: timelineGeometryUnchanged ? previous?.structuralHash || structuralHash : structuralHash, activeRungLabel: fsmRungLabel, mediaPlaylistPath, episodeChanged: episodeChangedByFingerprint, urlsChanged, timelineGeometryUnchanged })
  const playbackState = playbackTransition.state
  let qualityVariantSwitch = playbackTransition.qualitySwitch === true
  let shouldClearPrefetch = playbackTransition.clearPrefetch === true

  // Variant switch cooldown
  const variantCooldownMs = Number(constants.VARIANT_SWITCH_COOLDOWN_MS) || 2000
  const sinceLastVariantSwitch = Date.now() - Number(previous?.lastQualityVariantSwitchAt || 0)
  if (shouldClearPrefetch && sinceLastVariantSwitch < variantCooldownMs) {
    shouldClearPrefetch = false; qualityVariantSwitch = false
    addLog("DEBUG", `Blocked variant-switch prefetch purge on tab ${tabId} (${sinceLastVariantSwitch}ms since last, cooldown=${variantCooldownMs}ms)`)
    if (typeof ns.recordVariantSwitchCascadeBlocked === "function") ns.recordVariantSwitchCascadeBlocked()
  }
  if (isRoutinePlaylistRefresh) { shouldClearPrefetch = false; qualityVariantSwitch = false }
  const indexQualityRotation = urlsChanged && !segmentCountChanged && !episodeChangedByFingerprint && indexQuality && Number(indexQuality.coverage) >= 100
  if (indexQualityRotation) { shouldClearPrefetch = false; qualityVariantSwitch = false }
  const seekChurnActive = Date.now() < Number(previous?.seekChurnAggressiveUntil || 0) || Date.now() < Number(previous?.scrubbingTrainUntil || 0)
  if (seekChurnActive && urlsChanged && !episodeChangedByFingerprint && !segmentCountChanged) { shouldClearPrefetch = false; qualityVariantSwitch = false }

  if (urlsChanged && Array.isArray(previous?.segments) && previous.segments.length > 0) {
    if (shouldClearPrefetch) {
      ns.clearPrefetchTrackingForUrls(previous.segments)
      if (qualityVariantSwitch || episodeChangedByFingerprint) state.tabAnchorJumps.delete(tabId)
    }
  }
  if (isRoutinePlaylistRefresh && typeof previous?.anchorIndex === "number") addLog("DEBUG", `Routine playlist refresh on tab ${tabId} — preserving anchor ${previous.anchorIndex} and prefetch state`)
  if (playbackState === ns.PlaybackStates?.TOKEN_REFRESHING && urlsChanged && playbackTransition.retainAnchor && !playbackTransition.clearPrefetch && typeof ns.recordTokenRefreshRetention === "function") ns.recordTokenRefreshRetention()

  // Generation and registry
  let nextNetworkGeneration = Number(previous?.networkGeneration) || 0
  let nextPrefetchRegistry = previous?.prefetchDownloadRegistry instanceof Set ? previous.prefetchDownloadRegistry : new Set()
  if (episodeChangedByFingerprint) {
    if (previous) {
      if (typeof ns.bumpPlaybackGeneration === "function") nextNetworkGeneration = ns.bumpPlaybackGeneration(tabId, previous, "episode-changed")
      else if (typeof ns.bumpNetworkGeneration === "function") { nextNetworkGeneration = ns.bumpNetworkGeneration(tabId, previous, "episode-changed"); nextPrefetchRegistry = previous.prefetchDownloadRegistry }
      else { nextNetworkGeneration += 1; nextPrefetchRegistry = new Set() }
      ns.abortManifestRefreshForEpisode(tabId, previous, "episode-changed")
      ns.clearTabFailedPrefetches(previous)
      ns.releaseInflightForTab(tabId, { notifyPage: false, reason: "episode-changed" })
    } else { nextNetworkGeneration = 1; nextPrefetchRegistry = new Set() }
    logEpisodeSwitchPlaylistDiagnostic(tabId, previous, meta, mediaPlaylistPath)
    if (typeof ns.recordEpisodeTransitionSwitch === "function") ns.recordEpisodeTransitionSwitch(tabId)
    addLog("INFO", `New playback detected via ${pageNavigationNewPlayback ? "page navigation" : fingerprintReason || "unknown"} (score=${fingerprintScore}/${fingerprintAssessment.threshold}, tab ${tabId}) — not treating as signed-URL refresh`)
    if (typeof ns.bumpActivity === "function") ns.bumpActivity("playlistFingerprintNewPlayback", 1)
  } else if (urlsChanged && !isRoutinePlaylistRefresh && previous?.segments?.length) {
    if (typeof ns.bumpPlaylistGeneration === "function") ns.bumpPlaylistGeneration(previous, "playlist-url-rotation")
    nextNetworkGeneration = Number(previous.networkGeneration) || Number(previous.playbackGeneration) || 0
    nextPrefetchRegistry = previous.prefetchDownloadRegistry
    ns.clearTabFailedPrefetches(previous)
    addLog("DEBUG", `Playlist URL rotation on tab ${tabId} — playlist generation ${previous.playlistGeneration || 0} (queues retained)`)
  }

  // Anchor retention logic
  const authoritativeAnchorSource = previous?.anchorSource === "DOM_SEEKED" || previous?.anchorSource === "SEEK_PREDICTION"
  const anchorRecentlyAuthoritative = authoritativeAnchorSource && Date.now() - Number(previous?.anchorSourceAt || 0) < (Number(constants.SEEK_ANCHOR_RETAIN_MS) || 30_000)
  const staleEndOfTimelineAnchor = !episodeChangedByFingerprint && !anchorRecentlyAuthoritative && previous?.hasAnchor === true && typeof previous.anchorIndex === "number" && previous.anchorIndex >= normalizedSegments.length
  if (staleEndOfTimelineAnchor) addLog("INFO", `Cleared stale end-of-timeline anchor ${previous.anchorIndex} on tab ${tabId} (playlist length ${normalizedSegments.length})`)

  let hasAnchor = false, anchorIndex = null, anchorRetainedByRefresh = false, lastScheduledFromIndex = -1

  // Matrix anchor resolution
  if (!episodeChangedByFingerprint && !staleEndOfTimelineAnchor && qualityVariantSwitch && previous?.playlistMatrix?.rows?.length && typeof previous.anchorIndex === "number" && typeof ns.resolveMatrixAnchorIndex === "function") {
    const matrixIdx = ns.resolveMatrixAnchorIndex(previous.playlistMatrix, previous.anchorIndex, normalizedSegments.length)
    if (typeof matrixIdx === "number" && matrixIdx >= 0) { hasAnchor = true; anchorIndex = matrixIdx }
  }

  // Signature-based anchor
  if (!episodeChangedByFingerprint && !staleEndOfTimelineAnchor && !hasAnchor && previous?.hasAnchor && typeof previous.anchorIndex === "number" && Array.isArray(previous.segments) && previous.segments.length > 0) {
    const previousAnchorUrl = previous.segments[previous.anchorIndex]
    if (previousAnchorUrl) {
      const anchorSignature = ns.getManifestUrlSignature(previousAnchorUrl)
      if (anchorSignature) { const idx = signatureToIndex.get(anchorSignature); if (typeof idx === "number" && idx >= 0) { hasAnchor = true; anchorIndex = idx } }
    }
  }

  // Live media sequence anchor
  if (!episodeChangedByFingerprint && !staleEndOfTimelineAnchor && !hasAnchor && previous?.hasAnchor && typeof previous.anchorIndex === "number" && previous.isLive === true && typeof previous.anchorMediaSequence === "number" && typeof meta.mediaSequence === "number") {
    const remapped = previous.anchorMediaSequence - meta.mediaSequence
    if (remapped >= 0 && remapped < normalizedSegments.length) { hasAnchor = true; anchorIndex = remapped; anchorRetainedByRefresh = true }
  }

  // VOD retain anchor
  if (!episodeChangedByFingerprint && !staleEndOfTimelineAnchor && !hasAnchor && previous?.hasAnchor && typeof previous.anchorIndex === "number" && previous.isLive !== true && urlsChanged && playbackTransition.retainAnchor) {
    hasAnchor = true; anchorIndex = Math.min(Math.max(0, previous.anchorIndex), normalizedSegments.length - 1); anchorRetainedByRefresh = true
  }

  // Refresh snapshot anchor
  if (!episodeChangedByFingerprint && !staleEndOfTimelineAnchor && !hasAnchor && urlsChanged) {
    if (typeof previous?.lastAnchorMediaSequenceBeforeRefresh === "number" && typeof meta.mediaSequence === "number") {
      const remapped = previous.lastAnchorMediaSequenceBeforeRefresh - meta.mediaSequence
      if (remapped >= 0 && remapped < normalizedSegments.length) { hasAnchor = true; anchorIndex = remapped; anchorRetainedByRefresh = true }
    } else if (!episodeChangedByFingerprint && typeof previous?.lastAnchorBeforeRefresh === "number" && !structureChanged) {
      hasAnchor = true; anchorIndex = Math.min(Math.max(0, previous.lastAnchorBeforeRefresh), normalizedSegments.length - 1); anchorRetainedByRefresh = true
    }
  }

  if (hasAnchor) lastScheduledFromIndex = !playlistChanged && typeof previous?.lastScheduledFromIndex === "number" ? previous.lastScheduledFromIndex : -1

  // DOM anchor supremacy
  const authoritativeAnchor = previous?.anchorSource === "DOM_SEEKED" || previous?.anchorSource === "SEEK_PREDICTION"
  if (authoritativeAnchor && typeof previous?.anchorIndex === "number" && pageUnchanged && !episodeChangedByFingerprint && !staleEndOfTimelineAnchor) {
    if (!hasAnchor || typeof anchorIndex !== "number") {
      hasAnchor = true; anchorIndex = Math.min(Math.max(0, previous.anchorIndex), normalizedSegments.length - 1); anchorRetainedByRefresh = true
      addLog("DEBUG", `DOM anchor supremacy preserved index ${anchorIndex} across playlist refresh (tab ${tabId})`)
      if (typeof ns.recordDomAnchorSupremacyPreserved === "function") ns.recordDomAnchorSupremacyPreserved()
    }
  }

  // Rotated anchor raise from fresh playhead signals
  if (urlsChanged && typeof anchorIndex === "number" && anchorIndex <= 2 && previous?.hasAnchor) {
    const freshMs = Number(constants.ANCHOR_SIGNAL_FRESH_MS) || 3_000
    const playheadCandidates = []
    if (typeof previous.predictedAnchorIndex === "number" && Date.now() - Number(previous.predictedAnchorAt || 0) < freshMs) playheadCandidates.push(previous.predictedAnchorIndex)
    if (typeof previous.lastPlayerObservedIndex === "number" && Date.now() - Number(previous.lastPlayerObservedAt || 0) < freshMs) playheadCandidates.push(previous.lastPlayerObservedIndex)
    if (typeof previous.anchorIndex === "number" && previous.anchorIndex > anchorIndex) playheadCandidates.push(previous.anchorIndex)
    const raisedPlayhead = playheadCandidates.length ? Math.max(...playheadCandidates) : null
    if (typeof raisedPlayhead === "number" && raisedPlayhead > anchorIndex + 3) { const prevIdx = anchorIndex; anchorIndex = Math.min(raisedPlayhead, normalizedSegments.length - 1); hasAnchor = true; anchorRetainedByRefresh = true; addLog("DEBUG", `Rotation anchor raised ${prevIdx} -> ${anchorIndex} from fresh playhead signals (tab ${tabId})`) }
  }

  // Monotonic refresh anchor raise
  if (urlsChanged && !episodeChangedByFingerprint && previous?.hasAnchor && typeof previous.anchorIndex === "number" && typeof anchorIndex === "number" && anchorIndex < previous.anchorIndex - 1) {
    const floorIndex = Math.max(previous.anchorIndex, typeof previous.predictedAnchorIndex === "number" ? previous.predictedAnchorIndex : 0)
    if (floorIndex - anchorIndex > 1) { const prevIdx = anchorIndex; anchorIndex = Math.min(floorIndex, normalizedSegments.length - 1); hasAnchor = true; anchorRetainedByRefresh = true; addLog("DEBUG", `Monotonic refresh anchor raised ${prevIdx} -> ${anchorIndex} (tab ${tabId})`) }
  }

  // Anchor retained log
  if (anchorRetainedByRefresh && typeof anchorIndex === "number") addLog("INFO", `Retained playback anchor at index ${anchorIndex} after signed-URL refresh (${previous?.isLive === true ? "media-sequence" : "segment-index"}, tab ${tabId})`)

  // Quality switch log
  if (qualityVariantSwitch && playbackTransition.clearPrefetch) {
    const matrixNote = previous?.playlistMatrix?.rows?.length ? " (matrix O(1) anchor)" : ""
    const logAnchor = typeof anchorIndex === "number" ? anchorIndex : typeof previous?.anchorIndex === "number" ? previous.anchorIndex : "pending"
    addLog("INFO", `HLS quality variant switch on tab ${tabId}${matrixNote} — cleared stale prefetch tracking, resuming from anchor ${logAnchor}`)
    ns.notifyPageSeekingStateReset(tabId, { reason: "variant-switch", anchorIndex: typeof anchorIndex === "number" ? anchorIndex : previous?.anchorIndex, variantSwitchGraceUntil: Date.now() + (Number(constants.VARIANT_SWITCH_GRACE_MS) || 8_000) })
  } else if (playbackState === ns.PlaybackStates?.TOKEN_REFRESHING && urlsChanged && !playbackTransition.clearPrefetch) {
    const logAnchor = typeof anchorIndex === "number" ? anchorIndex : typeof previous?.anchorIndex === "number" ? previous.anchorIndex : "pending"
    addLog("DEBUG", `HLS playlist token refresh on tab ${tabId} — retained prefetch queue/inflight, anchor ${logAnchor}`)
  }

  // Sequence offset
  let sequenceOffset = 0
  if (urlsChanged && Array.isArray(previous?.segments) && previous.segments.length > 0) {
    if (typeof meta.mediaSequence === "number" && typeof previous?.mediaSequence === "number") sequenceOffset = meta.mediaSequence - previous.mediaSequence
    else if (normalizedSegments.length > 0 && typeof ns.getManifestUrlSignature === "function") {
      const newSig0 = ns.getManifestUrlSignature(normalizedSegments[0])
      if (newSig0) {
        for (let i = 0; i < Math.min(30, previous.segments.length); i++) { if (ns.getManifestUrlSignature(previous.segments[i]) === newSig0) { sequenceOffset = i; break } }
        if (sequenceOffset === 0) {
          const oldSig0 = ns.getManifestUrlSignature(previous.segments[0])
          if (oldSig0) { for (let i = 0; i < Math.min(30, normalizedSegments.length); i++) { if (ns.getManifestUrlSignature(normalizedSegments[i]) === oldSig0) { sequenceOffset = -i; break } } }
        }
      }
    }
  }

  const segmentUrlHistory = urlsChanged && Array.isArray(previous?.segments) && previous.segments.length > 0
    ? ns.mergeSegmentUrlHistory(previous.segmentUrlHistory, previous.segments, normalizedSegments, typeof anchorIndex === "number" ? anchorIndex : typeof previous?.anchorIndex === "number" ? previous.anchorIndex : null, sequenceOffset)
    : previous?.segmentUrlHistory instanceof Map ? new Map(previous.segmentUrlHistory) : new Map()

  // Build tab state object
  const tabState = {
    segments: normalizedSegments, segmentUrlHistory, manifestSignatures, signatureToIndex,
    indexQuality, indexQualityRecordedAt: indexQuality ? Date.now() : null,
    updatedAt: Date.now(), hasAnchor, anchorIndex,
    anchorMediaSequence: hasAnchor && typeof meta.mediaSequence === "number" && typeof anchorIndex === "number" ? meta.mediaSequence + anchorIndex : previous?.anchorMediaSequence ?? null,
    isLive: meta.isLive === true, mediaSequence: Number.isFinite(meta.mediaSequence) ? meta.mediaSequence : null,
    lastScheduledFromIndex, lastScheduledAt: previous?.lastScheduledAt || 0, lastSkipLogAt: previous?.lastSkipLogAt || 0,
    highChurnMode: qualityVariantSwitch || episodeChangedByFingerprint ? false : previous?.highChurnMode === true,
    prefetchCooldownUntil: qualityVariantSwitch || episodeChangedByFingerprint ? 0 : Number(previous?.prefetchCooldownUntil || 0),
    playlistRefreshedAt: urlsChanged ? Date.now() : Number(previous?.playlistRefreshedAt || 0),
    anchorRotationGraceUntil: urlsChanged ? Date.now() + constants.PLAYLIST_ROTATION_GRACE_MS : Number(previous?.anchorRotationGraceUntil || 0),
    tokensRefreshedAt: tokensRefreshed ? Date.now() : Number(previous?.tokensRefreshedAt || 0),
    mediaPlaylistUrl: meta.mediaPlaylistUrl ? (typeof ns.stripHash === "function" ? ns.stripHash(meta.mediaPlaylistUrl) || meta.mediaPlaylistUrl : meta.mediaPlaylistUrl) : previous?.mediaPlaylistUrl || null,
    episodeSwitchAt: episodeChangedByFingerprint ? Date.now() : Number(previous?.episodeSwitchAt || 0),
    lastManifestRefreshAt: Number(previous?.lastManifestRefreshAt || 0),
    anchorRetainedByRefresh: anchorRetainedByRefresh || previous?.anchorRetainedByRefresh === true,
    playlistFingerprint, structuralHash, durationGeometryHash,
    segmentDurations: Array.isArray(meta.segmentDurations) ? meta.segmentDurations : previous?.segmentDurations || null,
    discontinuityMarkers: Array.isArray(meta.discontinuityMarkers) ? meta.discontinuityMarkers : previous?.discontinuityMarkers || null,
    teleportModeUntil: episodeChangedByFingerprint ? 0 : Number(previous?.teleportModeUntil || 0),
    teleportTargetIndex: episodeChangedByFingerprint ? null : typeof previous?.teleportTargetIndex === "number" ? previous.teleportTargetIndex : null,
    seekChurnAggressiveUntil: episodeChangedByFingerprint ? 0 : Number(previous?.seekChurnAggressiveUntil || 0),
    predictedAnchorIndex: episodeChangedByFingerprint ? null : typeof previous?.predictedAnchorIndex === "number" ? previous.predictedAnchorIndex : null,
    predictedAnchorAt: episodeChangedByFingerprint ? 0 : Number(previous?.predictedAnchorAt || 0),
    lastPlayerObservedIndex: episodeChangedByFingerprint ? null : typeof previous?.lastPlayerObservedIndex === "number" ? previous.lastPlayerObservedIndex : null,
    lastPlayerObservedAt: episodeChangedByFingerprint ? 0 : Number(previous?.lastPlayerObservedAt || 0),
    velocityPredictedIndex: episodeChangedByFingerprint ? null : typeof previous?.velocityPredictedIndex === "number" ? previous.velocityPredictedIndex : null,
    velocityPredictedAt: episodeChangedByFingerprint ? 0 : Number(previous?.velocityPredictedAt || 0),
    anchorReconcileDivergenceSince: episodeChangedByFingerprint ? 0 : Number(previous?.anchorReconcileDivergenceSince || 0),
    anchorReconcileLastPromoteAt: episodeChangedByFingerprint ? 0 : Number(previous?.anchorReconcileLastPromoteAt || 0),
    playbackState, mediaPlaylistPath: mediaPlaylistPath || previous?.mediaPlaylistPath || null,
    fingerprintReason: fingerprintReason || null, fingerprintScore, fingerprintThreshold: fingerprintAssessment.threshold,
    playlistClassification: playbackState === ns.PlaybackStates?.NEW_PLAYBACK ? "new-playback" : playbackState === ns.PlaybackStates?.QUALITY_SWITCHING ? "quality-switch" : playbackState === ns.PlaybackStates?.TOKEN_REFRESHING ? "token-refresh" : playbackState === ns.PlaybackStates?.STABLE_PLAYBACK && urlsChanged ? "stable-refresh" : tokensRefreshed ? "token-refresh" : urlsChanged ? "urls-changed" : "unchanged",
    recentAnchorChanges: qualityVariantSwitch || segmentCountChanged || episodeChangedByFingerprint ? [] : previous?.recentAnchorChanges || [],
    rapidSeekUntil: qualityVariantSwitch || segmentCountChanged || episodeChangedByFingerprint ? 0 : Number(previous?.rapidSeekUntil || 0),
    lastQualityVariantSwitchAt: qualityVariantSwitch ? Date.now() : Number(previous?.lastQualityVariantSwitchAt || 0),
    variantSwitchGraceUntil: qualityVariantSwitch ? Date.now() + (Number(constants.VARIANT_SWITCH_GRACE_MS) || 8_000) : Number(previous?.variantSwitchGraceUntil || 0),
    variantSwitchAnchorIndex: qualityVariantSwitch ? (typeof anchorIndex === "number" ? anchorIndex : typeof previous?.anchorIndex === "number" ? previous.anchorIndex : null) : typeof previous?.variantSwitchAnchorIndex === "number" ? previous.variantSwitchAnchorIndex : null,
    prefetchInflightRetryTimer: previous?.prefetchInflightRetryTimer || null, prefetchInflightRetryPending: previous?.prefetchInflightRetryPending || null,
    lastKnownSyncAt: previous?.lastKnownSyncAt || 0, lastKnownSyncSignature: previous?.lastKnownSyncSignature || "",
    lastUpsertUrlsChanged: urlsChanged,
    manifestGeneration: Number(previous?.manifestGeneration) || 0, pendingManifestGeneration: Number(previous?.pendingManifestGeneration) || 0,
    refreshRecoveryUntil: Number(previous?.refreshRecoveryUntil || 0), refreshRecoverySuccessCount: Number(previous?.refreshRecoverySuccessCount || 0),
    refreshState: episodeChangedByFingerprint ? ns.REFRESH_STATE_HEALTHY : previous?.refreshState || ns.REFRESH_STATE_HEALTHY,
    manifestRefreshPending: episodeChangedByFingerprint ? false : previous?.manifestRefreshPending === true,
    manifestRefreshTimer: episodeChangedByFingerprint ? null : previous?.manifestRefreshTimer || null,
    prefetchFailureWindow: episodeChangedByFingerprint ? null : previous?.prefetchFailureWindow || null,
    prefetchPausedUntil: episodeChangedByFingerprint ? 0 : Number(previous?.prefetchPausedUntil || 0),
    refreshRetryAttempt: episodeChangedByFingerprint ? 0 : Number(previous?.refreshRetryAttempt || 0),
    refreshRetryTimer: episodeChangedByFingerprint ? null : previous?.refreshRetryTimer || null,
    lastAnchorBeforeRefresh: typeof previous?.lastAnchorBeforeRefresh === "number" ? previous.lastAnchorBeforeRefresh : null,
    lastAnchorMediaSequenceBeforeRefresh: typeof previous?.lastAnchorMediaSequenceBeforeRefresh === "number" ? previous.lastAnchorMediaSequenceBeforeRefresh : null,
    playlistMatrix: meta.playlistMatrix || previous?.playlistMatrix || null, masterPlaylistUrl: meta.masterPlaylistUrl || previous?.masterPlaylistUrl || null,
    activeRungLabel: meta.activeRungLabel || previous?.activeRungLabel || null, matrixBuiltAt: Number(meta.matrixBuiltAt || previous?.matrixBuiltAt || 0),
    lastSpeculativePrefetchAt: Number(previous?.lastSpeculativePrefetchAt || 0),
    lastQualitySwitchAt: qualityVariantSwitch ? Date.now() : Number(previous?.lastQualitySwitchAt || 0),
    lastQualitySwitchFromRung: qualityVariantSwitch ? previous?.activeRungLabel || null : previous?.lastQualitySwitchFromRung || null,
    anchorSource: previous?.anchorSource || null, anchorSourceAt: Number(previous?.anchorSourceAt || 0),
    lastDomTeleportAt: Number(previous?.lastDomTeleportAt || 0),
    scrubbingTrainUntil: Number(previous?.scrubbingTrainUntil || 0), unifiedSeekPassengerUntil: Number(previous?.unifiedSeekPassengerUntil || 0),
    lastSeekReleaseAt: Number(previous?.lastSeekReleaseAt || 0), lastScrubSeekAt: Number(previous?.lastScrubSeekAt || 0),
    scrubSnapBackUntil: Number(previous?.scrubSnapBackUntil || 0), mutePassiveHysteresisUntil: Number(previous?.mutePassiveHysteresisUntil || 0),
    playbackGeneration: nextNetworkGeneration, playlistGeneration: Number(previous?.playlistGeneration) || 0,
    networkGeneration: nextNetworkGeneration, prefetchDownloadRegistry: nextPrefetchRegistry,
    activeEngineMode: previous?.activeEngineMode || null, warmRecovery: previous?.warmRecovery === true,
    warmRecoveryAppliedAt: Number(previous?.warmRecoveryAppliedAt || 0),
    playlistRecaptureRequired: normalizedSegments.length > 0 ? false : previous?.playlistRecaptureRequired === true,
    activeInflightSegmentIndices: qualityVariantSwitch || episodeChangedByFingerprint || urlsChanged ? new Set() : previous?.activeInflightSegmentIndices instanceof Set ? previous.activeInflightSegmentIndices : new Set()
  }

  if (typeof ns.syncLegacyNetworkGeneration === "function") ns.syncLegacyNetworkGeneration(tabState)
  if (meta.mediaPlaylistUrl && tabState.playlistMatrix && typeof ns.applyMatrixToTabState === "function") ns.applyMatrixToTabState(tabState, meta.mediaPlaylistUrl)

  // Monotonic anchor merge for concurrent refresh
  if (!episodeChangedByFingerprint && tabState.hasAnchor && typeof tabState.anchorIndex === "number") {
    const concurrent = state.playlistByTab.get(tabId)
    if (concurrent?.hasAnchor && typeof concurrent.anchorIndex === "number" && tabState.anchorIndex < concurrent.anchorIndex - 1) {
      const floorIndex = Math.max(concurrent.anchorIndex, typeof concurrent.predictedAnchorIndex === "number" ? concurrent.predictedAnchorIndex : 0, typeof tabState.predictedAnchorIndex === "number" ? tabState.predictedAnchorIndex : 0)
      if (floorIndex > tabState.anchorIndex) { const prevAnchor = tabState.anchorIndex; tabState.anchorIndex = Math.min(floorIndex, tabState.segments.length - 1); tabState.hasAnchor = true; tabState.anchorRetainedByRefresh = true; addLog("DEBUG", `Monotonic anchor merge ${prevAnchor} -> ${tabState.anchorIndex} (concurrent refresh, tab ${tabId})`) }
    }
  }

  state.playlistByTab.set(tabId, tabState)

  // Bridge rotation aliases
  if (urlsChanged && Array.isArray(previous?.segments) && previous.segments.length > 0 && typeof ns.bridgePlaylistSegmentUrlAliases === "function") {
    const bridgeAnchor = typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : typeof previous?.anchorIndex === "number" ? previous.anchorIndex : 0
    let oldSegmentsToBridge = previous.segments, newSegmentsToBridge = normalizedSegments
    if (sequenceOffset > 0) oldSegmentsToBridge = previous.segments.slice(sequenceOffset)
    else if (sequenceOffset < 0) newSegmentsToBridge = normalizedSegments.slice(-sequenceOffset)
    const bridgePromise = ns.bridgePlaylistSegmentUrlAliases(oldSegmentsToBridge, newSegmentsToBridge, { anchorIndex: bridgeAnchor, radius: Math.max(Number(state.settings.prefetchWindow) * 3, 24) })
    tabState.pendingRotationBridge = bridgePromise
    void bridgePromise.then((bridged) => { if (bridged > 0) { addLog("DEBUG", `Bridged ${bridged} rotation cache aliases near anchor ${bridgeAnchor} (tab ${tabId})`); if (typeof ns.bumpActivity === "function") ns.bumpActivity("rotationAliasBridged", bridged) } }).catch(() => {}).finally(() => { if (tabState?.pendingRotationBridge === bridgePromise) tabState.pendingRotationBridge = null })
  }

  if (typeof ns.scheduleWarmRecoveryPersist === "function") ns.scheduleWarmRecoveryPersist()
  if (previous && Number(tabState.playbackGeneration) > Number(previous.playbackGeneration || previous.networkGeneration || 0) && typeof ns.broadcastDelegatedPrefetchAbort === "function") ns.broadcastDelegatedPrefetchAbort(tabId, tabState, { generation: tabState.playbackGeneration, reason: "playback-generation", log: false })

  if (qualityVariantSwitch && tabState.segments?.length) {
    ns.syncKnownSegmentsToPage(tabId, tabState.segments, { resetSeeking: true, anchorIndex: typeof tabState.variantSwitchAnchorIndex === "number" ? tabState.variantSwitchAnchorIndex : typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : null, reason: "quality-switch" })
    ns.scheduleVariantSwitchWarmPrefetch(tabId, tabState)
  }
  return tabState
}
})()
