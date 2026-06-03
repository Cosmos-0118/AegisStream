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
   * Continuous speculation score: confidence² × runway factor × congestion multiplier.
   * High runway can unlock conservative speculative prefetch below the legacy 75% cliff.
   */
  function calculateContinuousSpeculationPriority(sessionMetrics = {}, networkProfile = {}) {
    const confidence = Math.min(1, Math.max(0, Number(sessionMetrics.confidence) || 0))
    const runway = Number(networkProfile.runwaySec ?? networkProfile.currentBufferRunway)
    const targetRunway = Number(constants.SPECULATIVE_TARGET_RUNWAY_SEC) || 30
    const hardFloor = Number(constants.SPECULATIVE_CONTINUOUS_RUNWAY_FLOOR_SEC) || 5
    const threshold = Number(constants.SPECULATIVE_CONTINUOUS_THRESHOLD) || 0.35
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
    const structuralScore = confidence * confidence * runwayFactor

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
      speculativeAllowed: congestion?.speculativeAllowed
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
