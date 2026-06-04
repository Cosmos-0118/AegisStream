(() => {
  var ns = (self.AegisBackground ||= {})
  const { constants } = ns

  const SOURCE_PRIORITY = {
    "rescue-lane": 100,
    "buffer-emergency": 100,
    "teleport-purge": 95,
    "teleport-mode": 90,
    "teleport-lease": 88,
    "anchor-jump": 85,
    "scrub-snap-back": 84,
    "scrub-velocity-prewarm": 82,
    "quality-switch-warm": 87,
    "dom-seeked": 81,
    "seek-prediction": 78,
    "manifest-refresh": 40,
    "playlist-refresh": 38,
    "captured-playlist": 36,
    "chunk-observed": 30,
    "schedule": 20,
    anchor: 18
  }

  function prefetchSourcePriority(source) {
    const label = String(source || "schedule").toLowerCase()
    if (SOURCE_PRIORITY[label] != null) return SOURCE_PRIORITY[label]
    if (/rescue|emergency/.test(label)) return 100
    if (/teleport|scrub|velocity|snap|churn|seek-pred/.test(label)) return 80
    if (/chunk-observed|observed/.test(label)) return 30
    return 40
  }

  function resolveArbitrationMinGap(source, options = {}) {
    if (options.force === true) {
      const priority = prefetchSourcePriority(source)
      if (priority >= 80) {
        return Number(constants.SCRUB_DELEGATE_MIN_INTERVAL_MS) || 280
      }
      return Number(constants.SCHEDULER_ARBITRATE_MIN_MS) || 200
    }
    return Number(constants.SCHEDULER_ARBITRATE_MIN_MS) || 200
  }

  /**
   * Single coordination surface for engine mode + prefetch producer arbitration.
   */
  function arbitrateTabStreaming(tabState) {
    if (!tabState) return ns.EngineModes?.NORMAL || "NORMAL"
    const mode =
      typeof ns.evaluateStreamingUrgency === "function"
        ? ns.evaluateStreamingUrgency(tabState)
        : ns.EngineModes?.NORMAL || "NORMAL"
    if (typeof ns.applyEngineMode === "function") {
      ns.applyEngineMode(tabState, mode)
    }
    return mode
  }

  function arbitratePrefetchSchedule(tabId, tabState, source, options = {}) {
    const mode = arbitrateTabStreaming(tabState)
    const label = String(source || "schedule")
    const priority = prefetchSourcePriority(label)
    const now = Date.now()

    if (mode === ns.EngineModes?.RESCUE) {
      const rescueOnly =
        /rescue|buffer-emergency|quality-switch-warm|variant-switch-rescue/.test(label)
      if (!rescueOnly) {
        return { allow: false, mode, reason: "rescue-active", priority }
      }
      const lastRescueAt = Number(tabState.lastRescuePrefetchAt || 0)
      const rescueGap = Number(constants.RESCUE_SCHEDULE_MIN_MS) || 400
      if (now - lastRescueAt < rescueGap) {
        return { allow: false, mode, reason: "rescue-throttled", priority }
      }
      tabState.lastRescuePrefetchAt = now
      tabState.lastArbitratedPrefetchAt = now
      tabState.lastArbitratedPrefetchPriority = priority
      tabState.lastArbitratedPrefetchSource = label
      return { allow: true, mode, priority }
    }

    if (typeof ns.isRescueModeActive === "function" && ns.isRescueModeActive(tabState)) {
      if (/quality-switch-warm|variant-switch-rescue/.test(label)) {
        return { allow: true, mode, priority }
      }
      return { allow: false, mode, reason: "rescue-latched", priority }
    }

    if (
      label === "scrub-velocity-prewarm" &&
      Date.now() < Number(tabState.scrubSnapBackUntil || 0)
    ) {
      return { allow: false, mode, reason: "snap-back-active", priority }
    }
    if (
      label === "scrub-snap-back" &&
      Date.now() - Number(tabState.lastScrubVelocityScheduleAt || 0) <
        (Number(constants.SCRUB_DELEGATE_MIN_INTERVAL_MS) || 400)
    ) {
      return { allow: false, mode, reason: "velocity-lane", priority }
    }
    if (label === "seek-prediction") {
      const defer =
        typeof ns.isSeekPredictionPassengerPhase === "function"
          ? ns.isSeekPredictionPassengerPhase(tabState)
          : typeof ns.shouldDeferSeekPredictionPrefetch === "function" &&
            ns.shouldDeferSeekPredictionPrefetch(tabState)
      if (defer) {
        return { allow: false, mode, reason: "scrub-train-velocity-lane", priority }
      }
    }

    const minGap = resolveArbitrationMinGap(label, options)
    const lastAt = Number(tabState.lastArbitratedPrefetchAt || 0)
    const lastPri = Number(tabState.lastArbitratedPrefetchPriority || 0)
    if (now - lastAt < minGap && priority < lastPri) {
      return { allow: false, mode, reason: "superseded", priority }
    }

    tabState.lastArbitratedPrefetchAt = now
    tabState.lastArbitratedPrefetchPriority = priority
    tabState.lastArbitratedPrefetchSource = label
    return { allow: true, mode, priority }
  }

  ns.prefetchSourcePriority = prefetchSourcePriority
  ns.arbitratePrefetchSchedule = arbitratePrefetchSchedule
  ns.arbitrateTabStreaming = arbitrateTabStreaming
})()
