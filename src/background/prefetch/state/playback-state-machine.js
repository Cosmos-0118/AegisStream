(() => {
var ns = (self.AegisBackground ||= {})

const PlaybackStates = {
  IDLE: "IDLE",
  SESSION_ESTABLISHING: "SESSION_ESTABLISHING",
  STABLE_PLAYBACK: "STABLE_PLAYBACK",
  TOKEN_REFRESHING: "TOKEN_REFRESHING",
  QUALITY_SWITCHING: "QUALITY_SWITCHING",
  EPISODE_SWITCHED: "EPISODE_SWITCHED"
}

function normalizeText(v) {
  return String(v || "").trim().toLowerCase()
}

function getCompositeSessionKey(snapshot) {
  const pageUrl = normalizeText(snapshot?.pageUrl || snapshot?.pageUrlForFingerprint || "")
  const title = normalizeText(snapshot?.pageTitle || snapshot?.episodeTitle || "")
  const playlistPath = normalizeText(snapshot?.mediaPlaylistPath || "")
  const rung = normalizeText(snapshot?.activeRungLabel || "")
  const mediaSeq = Number.isFinite(Number(snapshot?.mediaSequence)) ? String(Number(snapshot.mediaSequence)) : ""
  const first = normalizeText(snapshot?.segments?.[0] || "")
  const second = normalizeText(snapshot?.segments?.[1] || "")
  const last = normalizeText(snapshot?.segments?.[Math.max(0, (snapshot?.segments?.length || 1) - 1)] || "")
  return [pageUrl, title, playlistPath, rung, mediaSeq, first, second, last].join("|")
}

/**
 * Session-based FSM driven by a composite playback identity and timeline invariants.
 */
function determinePlaybackTransition(previous, next) {
  const episodeChanged = next.episodeChanged === true
  const sessionKey = next.sessionKey || getCompositeSessionKey(next)
  // Only explicit session keys drive episode switches. Composite fallback keys are
  // too sensitive to omitted snapshot fields (e.g. segments) and would mis-classify
  // token refreshes as episode changes when callers pass partial next snapshots.
  const sessionChanged =
    Boolean(previous?.sessionKey) &&
    Boolean(next?.sessionKey) &&
    previous.sessionKey !== next.sessionKey
  const hasPrevious =
    Boolean(previous?.segments?.length) ||
    Boolean(previous?.structuralHash) ||
    Boolean(previous?.sessionKey)

  if (!hasPrevious) {
    return {
      state: PlaybackStates.SESSION_ESTABLISHING,
      clearPrefetch: false,
      retainAnchor: false,
      qualitySwitch: false,
      sessionKey,
      sessionChanged: true
    }
  }

  if (episodeChanged) {
    return {
      state: PlaybackStates.EPISODE_SWITCHED,
      clearPrefetch: true,
      retainAnchor: false,
      qualitySwitch: false,
      sessionKey,
      sessionChanged: true
    }
  }

  if (next.timelineGeometryUnchanged === true && next.urlsChanged === true) {
    return {
      state: PlaybackStates.TOKEN_REFRESHING,
      clearPrefetch: false,
      retainAnchor: true,
      qualitySwitch: false,
      sessionKey,
      sessionChanged: false
    }
  }

  const structuralHashChanged = Boolean(previous?.structuralHash) && Boolean(next?.structuralHash) && previous.structuralHash !== next.structuralHash
  const rungLabelChanged = Boolean(previous?.activeRungLabel) && Boolean(next?.activeRungLabel) && previous.activeRungLabel !== next.activeRungLabel
  const mediaPathChanged = Boolean(previous?.mediaPlaylistPath) && Boolean(next?.mediaPlaylistPath) && previous.mediaPlaylistPath !== next.mediaPlaylistPath
  const isUrlMutationOnly = next.urlsChanged === true && !structuralHashChanged && !rungLabelChanged && !mediaPathChanged

  if (isUrlMutationOnly) {
    return { state: PlaybackStates.TOKEN_REFRESHING, clearPrefetch: false, retainAnchor: true, qualitySwitch: false, sessionKey, sessionChanged: false }
  }

  // Session key drift should not dominate URL-rotation heuristics. We only
  // treat explicit session-key flips as new episodes when there is no URL
  // mutation evidence (e.g. explicit boundary marker from caller metadata).
  if (sessionChanged && next.urlsChanged !== true) {
    return {
      state: PlaybackStates.EPISODE_SWITCHED,
      clearPrefetch: true,
      retainAnchor: false,
      qualitySwitch: false,
      sessionKey,
      sessionChanged: true
    }
  }

  if (rungLabelChanged || mediaPathChanged) {
    if (!structuralHashChanged || !next.urlsChanged) {
      return { state: PlaybackStates.TOKEN_REFRESHING, clearPrefetch: false, retainAnchor: true, qualitySwitch: false, sessionKey, sessionChanged: false }
    }
    return { state: PlaybackStates.QUALITY_SWITCHING, clearPrefetch: true, retainAnchor: true, qualitySwitch: true, sessionKey, sessionChanged: false }
  }

  if (structuralHashChanged && next.urlsChanged) {
    return { state: PlaybackStates.STABLE_PLAYBACK, clearPrefetch: false, retainAnchor: true, qualitySwitch: false, sessionKey, sessionChanged: false }
  }

  if (next.urlsChanged) {
    return { state: PlaybackStates.TOKEN_REFRESHING, clearPrefetch: false, retainAnchor: true, qualitySwitch: false, sessionKey, sessionChanged: false }
  }

  return { state: PlaybackStates.STABLE_PLAYBACK, clearPrefetch: false, retainAnchor: true, qualitySwitch: false, sessionKey, sessionChanged: false }
}

ns.PlaybackStates = PlaybackStates
ns.determinePlaybackTransition = determinePlaybackTransition
})()
