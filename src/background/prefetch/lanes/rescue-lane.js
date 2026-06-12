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
    const exitRunway = Number(constants.RESCUE_EXIT_RUNWAY_SEC) || 8
    const exitHealth = Number(constants.RESCUE_EXIT_HEALTH_PCT) || 25
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

  /**
   * Best playhead estimate for rescue targeting. The committed anchor can be
   * stale during scrub trains (the "anchor=0, player at 8" failure mode), so
   * prefer the reconciled multi-signal consensus when one is available.
   */
  function resolveRescuePlayheadIndex(tabState) {
    if (typeof ns.resolveReconcileTargetIndex === "function") {
      const consensus = ns.resolveReconcileTargetIndex(tabState)
      if (typeof consensus === "number" && consensus >= 0) return consensus
    }
    if (typeof ns.getEffectiveAnchorIndex === "function") {
      const effective = ns.getEffectiveAnchorIndex(tabState)
      if (typeof effective === "number" && effective >= 0) return effective
    }
    return typeof tabState.anchorIndex === "number" && tabState.anchorIndex >= 0
      ? tabState.anchorIndex
      : 0
  }

  /**
   * Scoped rescue abort window: segment URLs near the playhead whose in-flight
   * fetches must survive the rescue abort broadcast. Only fetches outside this
   * window (far ahead / far behind) get killed.
   */
  function resolveRescueKeepWindow(tabState) {
    if (!Array.isArray(tabState?.segments) || !tabState.segments.length) return []
    const behind = Math.max(0, Number(constants.RESCUE_KEEP_BEHIND_SEGMENTS) || 2)
    const ahead = Math.max(1, Number(constants.RESCUE_KEEP_AHEAD_SEGMENTS) || 8)
    const playhead = resolveRescuePlayheadIndex(tabState)
    return tabState.segments.slice(
      Math.max(0, playhead - behind),
      Math.min(tabState.segments.length, playhead + ahead + 1)
    )
  }

  function resolveRescuePlayheadTargets(tabState, segments) {
    if (!tabState?.segments?.length || !Array.isArray(segments)) return []
    const ahead = Math.max(1, Number(constants.RESCUE_SEGMENTS_AHEAD) || 2)
    const start = Math.max(0, resolveRescuePlayheadIndex(tabState))
    const end = Math.min(segments.length, start + ahead)
    return segments.slice(start, end)
  }

  function broadcastAbortWithoutGenerationBump(tabId, tabState, options = {}) {
    if (typeof ns.broadcastDelegatedPrefetchAbort === "function") {
      const reason = typeof options === "string" ? options : options.reason
      const keepUrls = options.keepUrls || []
      ns.broadcastDelegatedPrefetchAbort(tabId, tabState, { reason, log: false, keepUrls })
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

    // Cooldown: don't nuke inflight work if we armed very recently.
    // The rescue *prefetch* still proceeds — we just skip the destructive
    // generation bump + abort broadcast that kills existing inflight fetches.
    const rescueCooldownMs = Number(constants.RESCUE_ARM_COOLDOWN_MS) || 2_000
    const lastArmAt = Number(tabState.lastRescueArmAt || 0)
    if (now - lastArmAt < rescueCooldownMs) {
      // Still suppress speculative work and pending retries.
      tabState.speculativeAllowed = false
      if (typeof ns.cancelPendingPrefetchForTab === "function") {
        ns.cancelPendingPrefetchForTab(tabId)
      }
      return
    }
    tabState.lastRescueArmAt = now

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

    const keepUrls = resolveRescueKeepWindow(tabState)

    if (canBumpGeneration) {
      tabState.lastRescueGenerationBumpAt = now
      if (typeof ns.bumpPlaybackGeneration === "function") {
        ns.bumpPlaybackGeneration(tabId, tabState, { reason, keepUrls })
      } else if (typeof ns.bumpNetworkGeneration === "function") {
        ns.bumpNetworkGeneration(tabId, tabState, { reason, keepUrls })
      }
      if (typeof ns.notePlaybackGenerationBump === "function") {
        ns.notePlaybackGenerationBump(false)
      }
    } else {
      broadcastAbortWithoutGenerationBump(tabId, tabState, { reason: `${reason}-throttled`, keepUrls })
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
    const source = options.source || "rescue-lane"
    const variantRecovery = isVariantSwitchRecovery(tabState, now)
    const softRescue =
      variantRecovery || source === "buffer-emergency" || source === "buffer-load-push"
    if (!softRescue) {
      armRescueLane(tabId, tabState, source)
    }
    const targets = resolveRescuePlayheadTargets(tabState, normalized)
    if (!targets.length) return false

    const playheadIndex =
      typeof resolveRescuePlayheadIndex === "function"
        ? resolveRescuePlayheadIndex(tabState)
        : typeof tabState.anchorIndex === "number"
          ? tabState.anchorIndex
          : 0
    tabState.lastScheduledFromIndex = playheadIndex
    tabState.lastScheduledAt = now
    tabState.updatedAt = now

    if (typeof ns.delegatePrefetchToPage === "function") {
      const rescueSource = variantRecovery
        ? "variant-switch-rescue"
        : source === "buffer-emergency" || source === "buffer-load-push"
          ? "buffer-load-push"
          : "rescue-lane"
      addLog(
        "INFO",
        softRescue
          ? `Non-destructive rescue prefetch of ${targets.length} segment(s) (tab ${tabId}, source=${rescueSource})`
          : `Engine mode: ${EngineModes.RESCUE} — delegated rescue prefetch of ${targets.length} segment(s) (tab ${tabId}, priority=high)`
      )
      const ok = await ns.delegatePrefetchToPage(tabId, targets, {
        source: rescueSource,
        priority: "high",
        replaceDelegated: softRescue ? false : true
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
  ns.resolveRescueKeepWindow = resolveRescueKeepWindow
  ns.resolveRescuePlayheadIndex = resolveRescuePlayheadIndex
  ns.resolveRescuePlayheadTargets = resolveRescuePlayheadTargets
  ns.evaluateStreamingUrgency = evaluateStreamingUrgency
  ns.applyEngineMode = applyEngineMode
  ns.executeRescuePrefetch = executeRescuePrefetch
  ns.isRescueModeActive = isRescueModeActive
  ns.isScrubbingTrainActive = isScrubbingTrainActive
})()
