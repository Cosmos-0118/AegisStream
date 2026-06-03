(() => {
  var ns = (self.AegisBackground ||= {})
  const { state } = ns

  function bumpActivity(metric, amount = 1) {
    if (typeof ns.bumpActivity === "function") {
      ns.bumpActivity(metric, amount)
    }
  }

  function ensureRescueStats() {
    if (!state.telemetry.rescueLane) {
      state.telemetry.rescueLane = {
        activations: 0,
        exits: 0,
        generationBumps: 0,
        generationBumpsThrottled: 0,
        abortBroadcasts: 0,
        rescuePrefetches: 0
      }
    }
    return state.telemetry.rescueLane
  }

  function noteRescueLaneActivation() {
    const bucket = ensureRescueStats()
    bucket.activations += 1
    if (typeof bumpActivity === "function") {
      bumpActivity("rescueLaneActivations", 1)
    }
  }

  function noteRescueLaneExit() {
    const bucket = ensureRescueStats()
    bucket.exits += 1
    if (typeof bumpActivity === "function") {
      bumpActivity("rescueLaneExits", 1)
    }
  }

  function notePlaybackGenerationBump(throttled = false) {
    const bucket = ensureRescueStats()
    if (throttled) {
      bucket.generationBumpsThrottled += 1
      if (typeof bumpActivity === "function") bumpActivity("playbackGenerationBumpsThrottled", 1)
    } else {
      bucket.generationBumps += 1
      if (typeof bumpActivity === "function") bumpActivity("playbackGenerationBumps", 1)
    }
  }

  function noteDelegatedAbortBroadcast() {
    const bucket = ensureRescueStats()
    bucket.abortBroadcasts += 1
    if (typeof bumpActivity === "function") bumpActivity("delegatedAbortBroadcasts", 1)
  }

  function noteRescuePrefetchDelegated(count = 1) {
    const bucket = ensureRescueStats()
    bucket.rescuePrefetches += Math.max(0, Number(count) || 0)
    if (typeof bumpActivity === "function") bumpActivity("rescuePrefetchesDelegated", count)
  }

  function formatRescueTelemetryLine() {
    const bucket = ensureRescueStats()
    if ((bucket.activations || 0) === 0 && (bucket.abortBroadcasts || 0) === 0) return ""
    return (
      `rescue(act=${bucket.activations}, exit=${bucket.exits}, genBump=${bucket.generationBumps}, ` +
      `genThrottled=${bucket.generationBumpsThrottled}, aborts=${bucket.abortBroadcasts}, ` +
      `delegated=${bucket.rescuePrefetches})`
    )
  }

  ns.noteRescueLaneActivation = noteRescueLaneActivation
  ns.noteRescueLaneExit = noteRescueLaneExit
  ns.notePlaybackGenerationBump = notePlaybackGenerationBump
  ns.noteDelegatedAbortBroadcast = noteDelegatedAbortBroadcast
  ns.noteRescuePrefetchDelegated = noteRescuePrefetchDelegated
  ns.formatRescueTelemetryLine = formatRescueTelemetryLine
  ns.getRescueTelemetrySnapshot = () => ({ ...ensureRescueStats() })
})()
