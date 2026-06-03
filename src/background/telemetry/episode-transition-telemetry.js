(() => {
  var ns = (self.AegisBackground ||= {})
  const transitions = new Map()

  function getTransition(tabId) {
    let row = transitions.get(tabId)
    if (!row) {
      row = {
        episodeSwitchAt: 0,
        refreshStartAt: 0,
        refreshDoneAt: 0,
        firstChunkAt: 0,
        playbackResumedAt: 0,
        lastLoggedAt: 0
      }
      transitions.set(tabId, row)
    }
    return row
  }

  function formatDelta(label, fromMs, toMs) {
    if (!fromMs || !toMs || toMs < fromMs) return null
    return `${label}=${toMs - fromMs}ms`
  }

  function maybeLogEpisodeTiming(tabId, row, force = false) {
    if (!row?.episodeSwitchAt) return
    const now = Date.now()
    if (!force && now - row.lastLoggedAt < 2_000) return

    const parts = []
    const sw = row.episodeSwitchAt
    if (row.refreshStartAt) {
      const d = formatDelta("switch→refreshStart", sw, row.refreshStartAt)
      if (d) parts.push(d)
    }
    if (row.refreshDoneAt) {
      const d = formatDelta("switch→refreshDone", sw, row.refreshDoneAt)
      if (d) parts.push(d)
      if (row.refreshStartAt) {
        const r = formatDelta("refreshDuration", row.refreshStartAt, row.refreshDoneAt)
        if (r) parts.push(r)
      }
    }
    if (row.firstChunkAt) {
      const d = formatDelta("switch→firstChunk", sw, row.firstChunkAt)
      if (d) parts.push(d)
      if (row.refreshDoneAt) {
        const d2 = formatDelta("refreshDone→firstChunk", row.refreshDoneAt, row.firstChunkAt)
        if (d2) parts.push(d2)
      }
    }
    if (row.playbackResumedAt) {
      const d = formatDelta("switch→playback", sw, row.playbackResumedAt)
      if (d) parts.push(d)
      if (row.firstChunkAt) {
        const d2 = formatDelta("firstChunk→playback", row.firstChunkAt, row.playbackResumedAt)
        if (d2) parts.push(d2)
      }
    }
    if (!parts.length) return

    row.lastLoggedAt = now
    if (typeof ns.addLog === "function") {
      ns.addLog("INFO", `Episode transition timing (tab ${tabId}): ${parts.join(", ")}`)
    }
  }

  function recordEpisodeTransitionSwitch(tabId) {
    const row = getTransition(tabId)
    const now = Date.now()
    row.episodeSwitchAt = now
    row.refreshStartAt = 0
    row.refreshDoneAt = 0
    row.firstChunkAt = 0
    row.playbackResumedAt = 0
    row.lastLoggedAt = 0
    if (typeof ns.addLog === "function") {
      ns.addLog("INFO", `Episode switch detected on tab ${tabId}`)
    }
  }

  function recordManifestRefreshStart(tabId) {
    const row = getTransition(tabId)
    if (!row.refreshStartAt) row.refreshStartAt = Date.now()
  }

  function recordManifestRefreshComplete(tabId) {
    const row = getTransition(tabId)
    if (row.refreshDoneAt) return
    row.refreshDoneAt = Date.now()
    maybeLogEpisodeTiming(tabId, row)
  }

  function recordFirstSuccessfulSegment(tabId) {
    const row = getTransition(tabId)
    if (row.firstChunkAt) return
    row.firstChunkAt = Date.now()
    maybeLogEpisodeTiming(tabId, row)
  }

  function recordPlaybackResumedAfterStall(tabId) {
    const row = getTransition(tabId)
    if (row.playbackResumedAt) return
    row.playbackResumedAt = Date.now()
    maybeLogEpisodeTiming(tabId, row, true)
  }

  function clearEpisodeTransitionTelemetry(tabId) {
    transitions.delete(tabId)
  }

  ns.recordEpisodeTransitionSwitch = recordEpisodeTransitionSwitch
  ns.recordManifestRefreshStart = recordManifestRefreshStart
  ns.recordManifestRefreshComplete = recordManifestRefreshComplete
  ns.recordFirstSuccessfulSegment = recordFirstSuccessfulSegment
  ns.recordPlaybackResumedAfterStall = recordPlaybackResumedAfterStall
  ns.clearEpisodeTransitionTelemetry = clearEpisodeTransitionTelemetry
})()
