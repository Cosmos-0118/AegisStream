(() => {
  var ns = (self.AegisBackground ||= {})
  const { constants, state, addLog } = ns

  const EngineModes = {
    NORMAL: "NORMAL",
    AGGRESSIVE: "AGGRESSIVE",
    RESCUE: "RESCUE"
  }

  function isScrubbingTrainActive(tabState) {
    if (!tabState) return false
    return Date.now() < Number(tabState.scrubbingTrainUntil || 0)
  }

  function isVariantSwitchRecovery(tabState, now = Date.now()) {
    if (!tabState) return false
    const graceUntil = Number(tabState.variantSwitchGraceUntil || 0)
    if (now >= graceUntil) return false
    const deferMs = Number(constants.VARIANT_SWITCH_RESCUE_DEFER_MS) || 4_000
    const switchedAt = Number(tabState.lastQualityVariantSwitchAt || 0)
    return switchedAt > 0 && now - switchedAt < deferMs
  }

  function shouldEnterRescue(tabState) {
    const runway = Number(tabState.bufferRunwaySec)
    const health = Number(tabState.bufferHealthScore)
    const enterRunway = Number(constants.RESCUE_ENTER_RUNWAY_SEC ?? constants.RESCUE_RUNWAY_SEC) || 3
    const enterHealth = Number(constants.RESCUE_ENTER_HEALTH_PCT ?? constants.RESCUE_HEALTH_PCT) || 5
    if (isVariantSwitchRecovery(tabState)) {
      const hardRunway = Math.min(enterRunway, 1)
      const hardHealth = Math.min(enterHealth, 2)
      if (tabState.bufferTier === "emergency" && Number.isFinite(runway) && runway < hardRunway) {
        return true
      }
      if (Number.isFinite(health) && health < hardHealth && Number.isFinite(runway) && runway < hardRunway) {
        return true
      }
      return false
    }
    if (tabState.bufferTier === "emergency") return true
    if (Number.isFinite(runway) && runway < enterRunway) return true
    if (Number.isFinite(health) && health < enterHealth) return true
    return false
  }

  function shouldExitRescue(tabState) {
    const runway = Number(tabState.bufferRunwaySec)
    const health = Number(tabState.bufferHealthScore)
    const exitRunway = Number(constants.RESCUE_EXIT_RUNWAY_SEC) || 5
    const exitHealth = Number(constants.RESCUE_EXIT_HEALTH_PCT) || 15
    if (tabState.bufferTier === "emergency") return false
    const runwayOk = !Number.isFinite(runway) || runway >= exitRunway
    const healthOk = !Number.isFinite(health) || health >= exitHealth
    return runwayOk && healthOk
  }

  function evaluateStreamingUrgency(tabState) {
    if (!tabState) return EngineModes.NORMAL

    if (tabState.rescueLaneLatched === true) {
      if (!shouldExitRescue(tabState)) {
        return EngineModes.RESCUE
      }
      tabState.rescueLaneLatched = false
    }

    if (shouldEnterRescue(tabState)) {
      tabState.rescueLaneLatched = true
      return EngineModes.RESCUE
    }

    // Buffer distress always wins over churn aggression (handled above).
    if (isScrubbingTrainActive(tabState) || Date.now() < Number(tabState.seekChurnAggressiveUntil || 0)) {
      return EngineModes.AGGRESSIVE
    }
    return EngineModes.NORMAL
  }

  function applyEngineMode(tabState, mode) {
    if (!tabState) return mode
    const previous = tabState.activeEngineMode
    tabState.activeEngineMode = mode
    if (mode === EngineModes.RESCUE) {
      tabState.speculativeAllowed = false
      if (previous !== EngineModes.RESCUE) {
        if (typeof ns.noteRescueLaneActivation === "function") {
          ns.noteRescueLaneActivation()
        }
        const runway = Number(tabState.bufferRunwaySec)
        const health = Number(tabState.bufferHealthScore)
        addLog(
          "WARN",
          `Rescue lane activated — runway=${Number.isFinite(runway) ? runway.toFixed(1) : "?"}s, health=${Number.isFinite(health) ? Math.round(health) : "?"}% (playhead-only prefetch, hysteresis latched)`
        )
        if (typeof ns.recordDecision === "function") {
          ns.recordDecision(
            "rescue-lane",
            "armed",
            `runway=${Number.isFinite(runway) ? runway.toFixed(1) : "?"}s, health=${Number.isFinite(health) ? health : "?"}%, latched=ON`
          )
        }
      }
    } else if (previous === EngineModes.RESCUE && typeof ns.noteRescueLaneExit === "function") {
      ns.noteRescueLaneExit()
      if (typeof ns.recordDecision === "function") {
        ns.recordDecision("rescue-lane", "released", `mode=${mode}`)
      }
    }
    return mode
  }

  function resolveRescuePlayheadTargets(tabState, segments) {
    if (!tabState?.segments?.length || !Array.isArray(segments)) return []
    const anchor =
      typeof tabState.anchorIndex === "number" && tabState.anchorIndex >= 0
        ? tabState.anchorIndex
        : 0
    const ahead = Math.max(1, Number(constants.RESCUE_SEGMENTS_AHEAD) || 2)
    const start = Math.max(0, anchor)
    const end = Math.min(segments.length, start + ahead)
    return segments.slice(start, end)
  }

  function broadcastAbortWithoutGenerationBump(tabId, tabState, reason) {
    if (typeof ns.broadcastDelegatedPrefetchAbort === "function") {
      ns.broadcastDelegatedPrefetchAbort(tabId, tabState, { reason, log: false })
    }
    if (typeof ns.noteDelegatedAbortBroadcast === "function") {
      ns.noteDelegatedAbortBroadcast()
    }
  }

  function armRescueLane(tabId, tabState, reason = "rescue") {
    if (!tabState) return
    if (isVariantSwitchRecovery(tabState)) {
      return
    }
    const now = Date.now()
    tabState.speculativeAllowed = false
    if (typeof ns.cancelPendingPrefetchForTab === "function") {
      ns.cancelPendingPrefetchForTab(tabId)
    }
    if (tabState.prefetchCapRetryTimer) {
      clearTimeout(tabState.prefetchCapRetryTimer)
      tabState.prefetchCapRetryTimer = null
    }
    tabState.prefetchCapRetryPending = null
    if (tabState.prefetchInflightRetryTimer) {
      clearTimeout(tabState.prefetchInflightRetryTimer)
      tabState.prefetchInflightRetryTimer = null
    }
    tabState.prefetchInflightRetryPending = null

    const minBumpMs = Number(constants.RESCUE_GENERATION_BUMP_MIN_MS) || 800
    const lastBumpAt = Number(tabState.lastRescueGenerationBumpAt || 0)
    const canBumpGeneration = now - lastBumpAt >= minBumpMs

    if (canBumpGeneration) {
      tabState.lastRescueGenerationBumpAt = now
      if (typeof ns.bumpPlaybackGeneration === "function") {
        ns.bumpPlaybackGeneration(tabId, tabState, reason)
      } else if (typeof ns.bumpNetworkGeneration === "function") {
        ns.bumpNetworkGeneration(tabId, tabState, reason)
      }
      if (typeof ns.notePlaybackGenerationBump === "function") {
        ns.notePlaybackGenerationBump(false)
      }
    } else {
      broadcastAbortWithoutGenerationBump(tabId, tabState, `${reason}-throttled`)
      if (typeof ns.notePlaybackGenerationBump === "function") {
        ns.notePlaybackGenerationBump(true)
      }
    }

    if (typeof ns.releaseInflightForTab === "function") {
      ns.releaseInflightForTab(tabId, { notifyPage: false })
    }
    if (!(tabState.prefetchDownloadRegistry instanceof Set)) {
      tabState.prefetchDownloadRegistry = new Set()
    } else {
      tabState.prefetchDownloadRegistry.clear()
    }
  }

  async function executeRescuePrefetch(tabId, tabState, segments, options = {}) {
    if (!tabState?.segments?.length) return false
    const now = Date.now()
    const minGap = Number(constants.RESCUE_SCHEDULE_MIN_MS) || 400
    if (now - Number(tabState.lastRescuePrefetchAt || 0) < minGap) {
      return true
    }
    tabState.lastRescuePrefetchAt = now
    const normalized = Array.isArray(segments) ? segments : tabState.segments
    const variantRecovery = isVariantSwitchRecovery(tabState, now)
    if (!variantRecovery) {
      armRescueLane(tabId, tabState, options.source || "rescue-lane")
    }
    const targets = resolveRescuePlayheadTargets(tabState, normalized)
    if (!targets.length) return false

    tabState.lastScheduledFromIndex =
      typeof tabState.anchorIndex === "number" ? tabState.anchorIndex : 0
    tabState.lastScheduledAt = now
    tabState.updatedAt = now

    if (typeof ns.delegatePrefetchToPage === "function") {
      const rescueSource = variantRecovery ? "variant-switch-rescue" : "rescue-lane"
      addLog(
        "INFO",
        variantRecovery
          ? `Variant-switch recovery prefetch of ${targets.length} segment(s) (tab ${tabId}, non-destructive)`
          : `Engine mode: ${EngineModes.RESCUE} — delegated rescue prefetch of ${targets.length} segment(s) (tab ${tabId}, priority=high)`
      )
      const ok = await ns.delegatePrefetchToPage(tabId, targets, {
        source: rescueSource,
        priority: "high",
        replaceDelegated: variantRecovery ? false : true
      })
      if (ok && typeof ns.noteRescuePrefetchDelegated === "function") {
        ns.noteRescuePrefetchDelegated(targets.length)
      }
      return ok
    }
    return false
  }

  function isRescueModeActive(tabState) {
    return tabState?.activeEngineMode === EngineModes.RESCUE || tabState?.rescueLaneLatched === true
  }

  ns.EngineModes = EngineModes
  ns.evaluateStreamingUrgency = evaluateStreamingUrgency
  ns.applyEngineMode = applyEngineMode
  ns.executeRescuePrefetch = executeRescuePrefetch
  ns.isRescueModeActive = isRescueModeActive
  ns.isScrubbingTrainActive = isScrubbingTrainActive
})()
