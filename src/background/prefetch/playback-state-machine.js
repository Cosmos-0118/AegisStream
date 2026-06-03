(() => {
var ns = (self.AegisBackground ||= {})

const PlaybackStates = {
  IDLE: "IDLE",
  STABLE_PLAYBACK: "STABLE_PLAYBACK",
  TOKEN_REFRESHING: "TOKEN_REFRESHING",
  QUALITY_SWITCHING: "QUALITY_SWITCHING",
  NEW_PLAYBACK: "NEW_PLAYBACK"
}

/**
 * Playlist lifecycle FSM driven by structural invariance (timeline hash + rung),
 * not raw signed URLs.
 */
function determinePlaybackTransition(previous, next) {
  const episodeChanged = next.episodeChanged === true
  const hasPrevious =
    Boolean(previous?.segments?.length) || Boolean(previous?.structuralHash)

  if (!hasPrevious) {
    return {
      state: PlaybackStates.IDLE,
      clearPrefetch: false,
      retainAnchor: false,
      qualitySwitch: false
    }
  }

  if (episodeChanged) {
    return {
      state: PlaybackStates.NEW_PLAYBACK,
      clearPrefetch: true,
      retainAnchor: false,
      qualitySwitch: false
    }
  }

  const structuralHashChanged =
    Boolean(previous?.structuralHash) &&
    Boolean(next?.structuralHash) &&
    previous.structuralHash !== next.structuralHash
  const rungLabelChanged =
    Boolean(previous?.activeRungLabel) &&
    Boolean(next?.activeRungLabel) &&
    previous.activeRungLabel !== next.activeRungLabel
  const mediaPathChanged =
    Boolean(previous?.mediaPlaylistPath) &&
    Boolean(next?.mediaPlaylistPath) &&
    previous.mediaPlaylistPath !== next.mediaPlaylistPath
  const isUrlMutationOnly =
    next.urlsChanged === true && !structuralHashChanged && !rungLabelChanged

  if (isUrlMutationOnly) {
    return {
      state: PlaybackStates.TOKEN_REFRESHING,
      clearPrefetch: false,
      retainAnchor: true,
      qualitySwitch: false
    }
  }

  if (rungLabelChanged || mediaPathChanged) {
    return {
      state: PlaybackStates.QUALITY_SWITCHING,
      clearPrefetch: true,
      retainAnchor: true,
      qualitySwitch: true
    }
  }

  if (structuralHashChanged && next.urlsChanged) {
    return {
      state: PlaybackStates.STABLE_PLAYBACK,
      clearPrefetch: false,
      retainAnchor: true,
      qualitySwitch: false
    }
  }

  if (next.urlsChanged) {
    return {
      state: PlaybackStates.TOKEN_REFRESHING,
      clearPrefetch: false,
      retainAnchor: true,
      qualitySwitch: false
    }
  }

  return {
    state: PlaybackStates.STABLE_PLAYBACK,
    clearPrefetch: false,
    retainAnchor: true,
    qualitySwitch: false
  }
}

ns.PlaybackStates = PlaybackStates
ns.determinePlaybackTransition = determinePlaybackTransition
})()
