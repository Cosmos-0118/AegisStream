(() => {
  var ns = (self.AegisBackground ||= {})
  const { constants } = ns

  function resolveCongestionTier(networkProfile = {}) {
    const tier = String(networkProfile.activeTierName || networkProfile.tier || "NOMINAL").toUpperCase()
    if (tier === "CRITICAL" || tier === "RESCUE") return "CRITICAL"
    if (tier === "CONGESTED" || tier === "AGGRESSIVE") return "CONGESTED"
    return "NOMINAL"
  }

  /**
   * Continuous speculation score: confidence^1.5 × runway factor × congestion multiplier.
   * Using confidence^1.5 instead of confidence² so that moderate confidence (~40-50%)
   * still yields a viable score. This is critical for quality recovery: when the
   * player drops to a low quality (360p), speculative adjacent-rung prefetch is the
   * only mechanism that can pull it back up. Blocking speculation at 94% rate means
   * the player stays permanently stuck at low quality in auto mode.
   */
  function calculateContinuousSpeculationPriority(sessionMetrics = {}, networkProfile = {}) {
    const confidence = Math.min(1, Math.max(0, Number(sessionMetrics.confidence) || 0))
    const runway = Number(networkProfile.runwaySec ?? networkProfile.currentBufferRunway)
    const targetRunway = Number(constants.SPECULATIVE_TARGET_RUNWAY_SEC) || 30
    const hardFloor = Number(constants.SPECULATIVE_CONTINUOUS_RUNWAY_FLOOR_SEC) || 5
    const threshold = Number(constants.SPECULATIVE_CONTINUOUS_THRESHOLD) || 0.20
    const aggressiveThreshold =
      Number(constants.SPECULATIVE_CONTINUOUS_AGGRESSIVE_THRESHOLD) || 0.7

    if (!Number.isFinite(runway) || runway <= hardFloor) {
      return {
        allowSpeculation: false,
        priorityTier: "NONE",
        score: 0,
        runwayFactor: 0,
        congestionMultiplier: 0
      }
    }

    const congestionTier = resolveCongestionTier(networkProfile)
    if (congestionTier === "CRITICAL") {
      return {
        allowSpeculation: false,
        priorityTier: "NONE",
        score: 0,
        runwayFactor: 0,
        congestionMultiplier: 0
      }
    }

    const runwayFactor = Math.min(2, runway / targetRunway)
    // Use confidence^1.5 instead of confidence² to give moderate confidence (~42%)
    // a viable score: 0.42^1.5 ≈ 0.272 vs 0.42² ≈ 0.176. With runwayFactor=2,
    // this yields 0.544 vs 0.352 — above the threshold instead of barely at it.
    let structuralScore = Math.pow(confidence, 1.5) * runwayFactor

    // Quality-recovery boost: when the player is stuck at the lowest available
    // quality rung, amplify speculation to allow higher-quality rung prefetch.
    // Without this, the player can get permanently stuck at low quality in auto mode
    // because speculation is the only mechanism that prefetches adjacent quality rungs.
    if (networkProfile?.activeRungLabel && networkProfile?.rungLabels?.length > 1) {
      const rungs = networkProfile.rungLabels
      const currentIndex = rungs.indexOf(networkProfile.activeRungLabel)
      const highestIndex = rungs.length - 1
      
      if (currentIndex >= 0 && currentIndex < highestIndex) {
        // Player is below maximum quality. Provide a progressive boost
        // based on how far it dropped to help recovery.
        // Bottom rung gets 2.5x, next rung gets less, but always at least 1.3x
        const dropRatio = 1 - (currentIndex / highestIndex)
        const progressiveBoost = 1.3 + (1.2 * dropRatio)
        structuralScore *= progressiveBoost
      }
    }

    let congestionMultiplier = 1
    if (congestionTier === "CONGESTED") {
      congestionMultiplier = Number(constants.SPECULATIVE_CONGESTED_MULTIPLIER) || 0.3
    } else if (networkProfile.speculativeAllowed === false) {
      congestionMultiplier = Number(constants.SPECULATIVE_NOMINAL_BLOCKED_MULTIPLIER) || 0.5
    }

    const finalScore = structuralScore * congestionMultiplier
    const allowSpeculation = finalScore >= threshold

    return {
      allowSpeculation,
      priorityTier: !allowSpeculation
        ? "NONE"
        : finalScore >= aggressiveThreshold
          ? "AGGRESSIVE_HQ"
          : "CONSERVATIVE_LQ",
      score: Math.round(finalScore * 1000) / 1000,
      runwayFactor: Math.round(runwayFactor * 1000) / 1000,
      congestionMultiplier
    }
  }

  function buildSessionMetricsForSpeculation() {
    const confidence =
      typeof ns.getPredictionConfidence === "function" ? ns.getPredictionConfidence() : 0.5
    return { confidence }
  }

  function buildNetworkProfileForSpeculation(tabId, tabState = null) {
    const resolved =
      tabState ||
      (ns.state?.playlistByTab?.get(tabId) ?? null)
    const congestion =
      resolved?.congestionDirectives ||
      (typeof ns.computeCongestionDirectivesForTab === "function"
        ? ns.computeCongestionDirectivesForTab(tabId)
        : null)
    return {
      runwaySec: Number(resolved?.bufferRunwaySec),
      currentBufferRunway: Number(resolved?.bufferRunwaySec),
      activeTierName: congestion?.activeTierName || resolved?.bufferTier || "NOMINAL",
      tier: resolved?.bufferTier || "NOMINAL",
      speculativeAllowed: congestion?.speculativeAllowed,
      // Quality-recovery boost info
      activeRungLabel: resolved?.activeRungLabel || null,
      rungLabels: resolved?.playlistMatrix?.rungLabels || resolved?.rungLabels || []
    }
  }

  function evaluateContinuousSpeculation(tabId, tabState = null) {
    const sessionMetrics = buildSessionMetricsForSpeculation()
    const networkProfile = buildNetworkProfileForSpeculation(tabId, tabState)
    return calculateContinuousSpeculationPriority(sessionMetrics, networkProfile)
  }

  function isContinuousSpeculationAllowed(tabId, tabState = null) {
    return evaluateContinuousSpeculation(tabId, tabState).allowSpeculation === true
  }

  ns.calculateContinuousSpeculationPriority = calculateContinuousSpeculationPriority
  ns.evaluateContinuousSpeculation = evaluateContinuousSpeculation
  ns.isContinuousSpeculationAllowed = isContinuousSpeculationAllowed
})()
