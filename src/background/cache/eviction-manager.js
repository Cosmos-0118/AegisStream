(() => {
  var ns = (self.AegisBackground ||= {})
  const { constants, state } = ns

  let lane2TimerId = null
  let lane2DeferredTimerId = null
  let lane3IntervalId = null
  let lastSuppressionTelemetryAt = 0

  function monotonicNow() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now()
    }
    return Date.now()
  }

  function isTabEvictionSuppressed(tabId, now = Date.now()) {
    if (!Number.isFinite(tabId)) return false
    const tabState = state.playlistByTab.get(tabId)
    if (!tabState) return false
    if (
      typeof ns.isScrubbingTrainActive === "function" &&
      ns.isScrubbingTrainActive(tabState, now)
    ) {
      return true
    }
    if (
      typeof ns.isTabInSeekChurnAggressive === "function" &&
      ns.isTabInSeekChurnAggressive(tabState)
    ) {
      return true
    }
    return (
      now < Number(tabState.scrubbingTrainUntil || 0) ||
      now < Number(tabState.seekChurnAggressiveUntil || 0)
    )
  }

  function isAnyTabEvictionSuppressed(now = Date.now()) {
    const activeTabId = state.activePrefetchTabId
    if (Number.isFinite(activeTabId) && isTabEvictionSuppressed(activeTabId, now)) {
      return true
    }
    for (const [tabId, tabState] of state.playlistByTab.entries()) {
      if (Number.isFinite(activeTabId) && tabId === activeTabId) continue
      if (
        typeof ns.isScrubbingTrainActive === "function" &&
        ns.isScrubbingTrainActive(tabState, now)
      ) {
        return true
      }
      if (
        typeof ns.isTabInSeekChurnAggressive === "function" &&
        ns.isTabInSeekChurnAggressive(tabState)
      ) {
        return true
      }
      if (now < Number(tabState?.scrubbingTrainUntil || 0)) return true
      if (now < Number(tabState?.seekChurnAggressiveUntil || 0)) return true
    }
    return false
  }

  function evaluatePressure(summary, policy) {
    const maxBytes = Math.max(1, Number(policy?.maxBytes) || 1)
    const maxEntries = Math.max(1, Number(policy?.maxEntries) || 1)
    const totalBytes = Math.max(0, Number(summary?.totalBytes) || 0)
    const totalEntries = Math.max(0, Number(summary?.totalEntries) || 0)
    const bytesRatio = totalBytes / maxBytes
    const entriesRatio = totalEntries / maxEntries
    const softBytes = Number(constants.CACHE_EVICTION_SOFT_BYTES_RATIO) || 0.85
    const softEntries = Number(constants.CACHE_EVICTION_SOFT_ENTRIES_RATIO) || 0.9
    const hardBytes = Number(constants.CACHE_EVICTION_HARD_BYTES_RATIO) || 0.95
    const hardEntries = Number(constants.CACHE_EVICTION_HARD_ENTRIES_RATIO) || 0.95
    const lane3Min = Number(constants.CACHE_EVICTION_LANE3_MIN_RATIO) || 0.7
    const overBudget = totalBytes > maxBytes || totalEntries > maxEntries
    const overSoftThreshold = bytesRatio >= softBytes || entriesRatio >= softEntries
    const overHardThreshold = bytesRatio >= hardBytes || entriesRatio >= hardEntries
    const lane3Eligible = Math.max(bytesRatio, entriesRatio) >= lane3Min
    return {
      bytesRatio,
      entriesRatio,
      overBudget,
      overSoftThreshold,
      overHardThreshold,
      lane3Eligible
    }
  }

  function shouldScheduleSoftEviction(pressure) {
    if (pressure.overHardThreshold || pressure.overBudget) return true
    if (!pressure.overSoftThreshold) return false

    if (isAnyTabEvictionSuppressed()) {
      const now = monotonicNow()
      const cooldownMs = Number(constants.CACHE_EVICTION_SCRUB_DEFER_MS) || 5_000
      if (now - lastSuppressionTelemetryAt > cooldownMs) {
        lastSuppressionTelemetryAt = now
        if (typeof ns.bumpActivity === "function") {
          ns.bumpActivity("evictionSuppressedByScrub", 1)
        }
        if (typeof ns.addLog === "function") {
          ns.addLog(
            "DEBUG",
            `Eviction pass soft-suppressed. Storage: ${(pressure.bytesRatio * 100).toFixed(1)}% capacity. Active scrub train detected.`
          )
        }
      }
      return false
    }

    return true
  }

  function clearLane2Timers() {
    if (lane2TimerId) {
      clearTimeout(lane2TimerId)
      lane2TimerId = null
    }
    if (lane2DeferredTimerId) {
      clearTimeout(lane2DeferredTimerId)
      lane2DeferredTimerId = null
    }
  }

  function armLane2Pass(delayMs, force) {
    if (lane2TimerId) clearTimeout(lane2TimerId)
    lane2TimerId = setTimeout(() => {
      lane2TimerId = null
      if (typeof ns.runEvictionPass === "function") {
        void ns.runEvictionPass(force, { lane: force ? "hard" : "soft" }).catch(() => {})
      }
    }, delayMs)
  }

  function scheduleLane2DeferredPass() {
    const deferMs = Number(constants.CACHE_EVICTION_SCRUB_DEFER_MS) || 5_000
    if (lane2DeferredTimerId) clearTimeout(lane2DeferredTimerId)
    lane2DeferredTimerId = setTimeout(() => {
      lane2DeferredTimerId = null
      void triggerLane2FromPressure().catch(() => {})
    }, deferMs)
  }

  async function triggerLane2FromPressure() {
    if (typeof ns.evaluateCachePressure !== "function") return
    const snapshot = await ns.evaluateCachePressure()
    if (!snapshot?.summary || !snapshot?.policy) return
    const pressure = evaluatePressure(snapshot.summary, snapshot.policy)
    if (!pressure.overSoftThreshold && !pressure.overBudget && !pressure.overHardThreshold) {
      return
    }
    if (pressure.overHardThreshold || pressure.overBudget) {
      if (pressure.overHardThreshold && typeof ns.addLog === "function") {
        ns.addLog(
          "INFO",
          `HARD_THRESHOLD_BREACH: cache at ${(pressure.bytesRatio * 100).toFixed(1)}% bytes / ${(pressure.entriesRatio * 100).toFixed(1)}% entries — scrub suppression bypassed`
        )
      }
      armLane2Pass(100, true)
      return
    }
    if (!shouldScheduleSoftEviction(pressure)) {
      if (pressure.overSoftThreshold) {
        scheduleLane2DeferredPass()
      }
      return
    }
    const debounceMs = Number(constants.CACHE_EVICTION_DEBOUNCE_MS) || 2_000
    armLane2Pass(debounceMs, false)
  }

  /**
   * Lane 1 (force): hard breaker — immediate, never scrub-suppressed.
   * Lane 2: soft threshold + scrub trailing-edge coalesce.
   */
  function scheduleEviction(force = false) {
    if (force) {
      clearLane2Timers()
      armLane2Pass(100, true)
      return
    }
    void triggerLane2FromPressure()
  }

  async function runLane3ReconcileTick() {
    if (typeof ns.evaluateCachePressure !== "function") return
    if (typeof ns.runEvictionPass !== "function") return
    const snapshot = await ns.evaluateCachePressure()
    if (!snapshot?.summary || !snapshot?.policy) return
    const pressure = evaluatePressure(snapshot.summary, snapshot.policy)
    if (!pressure.lane3Eligible) return
    if (!shouldScheduleSoftEviction(pressure)) return
    await ns.runEvictionPass(false, { lane: "reconcile" })
  }

  function startLane3ReconcileLoop() {
    if (lane3IntervalId) return
    const intervalMs = Number(constants.CACHE_EVICTION_LANE3_INTERVAL_MS) || 45_000
    lane3IntervalId = setInterval(() => {
      void runLane3ReconcileTick().catch(() => {})
    }, intervalMs)
  }

  ns.isTabEvictionSuppressed = isTabEvictionSuppressed
  ns.isAnyTabEvictionSuppressed = isAnyTabEvictionSuppressed
  ns.shouldScheduleSoftEviction = shouldScheduleSoftEviction
  ns.resetSuppressionTelemetryCooldown = () => {
    lastSuppressionTelemetryAt = 0
  }
  ns.evaluateCachePressureRatios = evaluatePressure
  ns.scheduleEviction = scheduleEviction
  ns.startLane3ReconcileLoop = startLane3ReconcileLoop
})()
