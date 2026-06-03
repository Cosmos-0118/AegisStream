(() => {
  var ns = (self.AegisBackground ||= {})
  const { state, addLog } = ns

  const MAX_JOURNAL_ENTRIES = 12
  const OBSERVABILITY_LOG_INTERVAL_MS = 45_000

  const PAIN = {
    cacheMiss: "painCacheMiss",
    playbackStall: "painPlaybackStall",
    predictorBlocked: "painPredictorBlocked",
    speculativeDenied: "painSpeculativeDenied",
    congestionThrottle: "painCongestionThrottle",
    laneBlocked: "painLaneBlocked",
    prefetchCap: "painPrefetchCap",
    storeFailed: "painStoreFailed"
  }

  const journal = []
  let lastObservabilityLogAt = 0
  let lastSpeculativeDenyLogAt = 0

  function bumpPain(metric, amount = 1) {
    if (typeof ns.bumpActivity === "function") {
      ns.bumpActivity(metric, amount)
    }
  }

  function recordDecision(topic, decision, reason) {
    journal.push({
      at: Date.now(),
      topic: String(topic || "system"),
      decision: String(decision || "unknown"),
      reason: String(reason || "")
    })
    if (journal.length > MAX_JOURNAL_ENTRIES) {
      journal.splice(0, journal.length - MAX_JOURNAL_ENTRIES)
    }
  }

  function notePainCacheMiss(amount = 1) {
    bumpPain(PAIN.cacheMiss, amount)
  }

  function notePainPlaybackStall(durationMs = 0) {
    const weight = Math.max(1, Math.round(Number(durationMs) / 1000) || 1)
    bumpPain(PAIN.playbackStall, weight)
  }

  function notePainPredictorBlocked() {
    bumpPain(PAIN.predictorBlocked, 1)
  }

  function notePainSpeculativeDenied(reason) {
    bumpPain(PAIN.speculativeDenied, 1)
    const now = Date.now()
    if (now - lastSpeculativeDenyLogAt < 8_000) return
    lastSpeculativeDenyLogAt = now
    recordDecision("speculation", "denied", reason)
  }

  function notePainCongestionThrottle(reason) {
    bumpPain(PAIN.congestionThrottle, 1)
    recordDecision("congestion", "throttle", reason)
  }

  function notePainLaneBlocked(lane, count = 1) {
    bumpPain(PAIN.laneBlocked, count)
    if (count > 0) {
      recordDecision("teleport-lane", "budget-exhausted", `lane=${lane}, blocked=${count}`)
    }
  }

  function notePainPrefetchCap(inflight, cap, tierLabel) {
    bumpPain(PAIN.prefetchCap, 1)
    recordDecision(
      "prefetch",
      "cap-retry",
      `inflight ${inflight}/${cap}, tier=${tierLabel || "unknown"}`
    )
  }

  function notePainStoreFailed(source) {
    bumpPain(PAIN.storeFailed, 1)
    recordDecision("cache-store", "failed", source || "unknown")
  }

  function findActiveTeleportLane(now = Date.now()) {
    let best = null
    for (const [, tabState] of state.playlistByTab || []) {
      const until = Number(tabState?.teleportPriorityUntil || 0)
      if (until <= now) continue
      const remainingSec = Math.max(0, (until - now) / 1000)
      if (!best || remainingSec > best.remainingSec) {
        best = {
          remainingSec,
          focusIndex: tabState.teleportPriorityIndex,
          tabId: tabState.tabId
        }
      }
    }
    return best
  }

  function buildLiveDecisionLines(now = Date.now()) {
    const lines = []
    const seekSummary =
      typeof ns.getSeekPredictionSummary === "function"
        ? ns.getSeekPredictionSummary()
        : null
    if (seekSummary) {
      const confPct = Math.round((seekSummary.confidence || 0) * 100)
      const disableBelow =
        Math.round((Number(ns.constants?.SEEK_PREDICTION_DISABLE_THRESHOLD) || 0.35) * 100)
      const specAbove =
        Math.round((Number(ns.constants?.SEEK_PREDICTION_SPECULATIVE_THRESHOLD) || 0.75) * 100)
      if (!seekSummary.enabled) {
        lines.push(
          `Predictor: OFF — confidence=${confPct}% below disable threshold ${disableBelow}%`
        )
      } else {
        lines.push(
          `Predictor: ON — confidence=${confPct}%, hitRate=${Math.round((seekSummary.hitRate || 0) * 100)}%`
        )
      }
      if (!seekSummary.speculative) {
        lines.push(
          seekSummary.enabled
            ? `Speculation: denied — confidence=${confPct}% below speculative threshold ${specAbove}%`
            : `Speculation: denied — predictor OFF (confidence=${confPct}%)`
        )
      } else {
        lines.push(`Speculation: allowed — confidence=${confPct}%`)
      }
    }

    const teleport = findActiveTeleportLane(now)
    if (teleport) {
      const focus =
        typeof teleport.focusIndex === "number" ? teleport.focusIndex : "?"
      lines.push(
        `Teleport lane: ACTIVE — expires in ${teleport.remainingSec.toFixed(1)}s, focus index ${focus}`
      )
    } else {
      lines.push("Teleport lane: idle")
    }

    const tabId = state.activePrefetchTabId
    const tabState = Number.isFinite(tabId) ? state.playlistByTab?.get(tabId) : null
    const directives =
      Number.isFinite(tabId) && typeof ns.computeCongestionDirectivesForTab === "function"
        ? ns.computeCongestionDirectivesForTab(tabId)
        : typeof ns.computeCongestionDirectives === "function"
          ? ns.computeCongestionDirectives(
              state.stats,
              null,
              Math.max(1, Number(state.settings?.prefetchWindow) || 8)
            )
          : null
    if (directives) {
      const tier = directives.activeTierName || "unknown"
      const spec = directives.speculativeAllowed ? "ON" : "OFF"
      lines.push(
        `Congestion: tier=${tier}, speculative=${spec}, inflightCap=${directives.maxInflight}, radius=${directives.prefetchRadius}`
      )
    }

    if (tabState?.activeEngineMode) {
      const latch = tabState.rescueLaneLatched ? ", rescueLatched=ON" : ""
      lines.push(`Engine mode: ${tabState.activeEngineMode}${latch}`)
    }

    const collapse = state.telemetry?.requestCollapse
    if (collapse && collapse.hits > 0) {
      const savedMb = (collapse.savedBytes / (1024 * 1024)).toFixed(1)
      lines.push(
        `Collapse saved: ${collapse.hits} hits, ${collapse.savedFetches} fetches, ${savedMb}MB`
      )
    }

    const stores = state.telemetry?.chunkStore
    if (stores) {
      const attempts = (stores.successfulStores || 0) + (stores.failedStores || 0)
      if (attempts > 0) {
        lines.push(
          `Cache stores: ok=${stores.successfulStores}, fail=${stores.failedStores}`
        )
      }
    }

    return lines
  }

  function formatRecentJournal() {
    if (journal.length === 0) return ""
    return journal
      .slice(-4)
      .map((entry) => `${entry.topic}: ${entry.decision} (${entry.reason})`)
      .join("; ")
  }

  function buildPainReport() {
    const totals =
      typeof ns.sumWindowCounters === "function" ? ns.sumWindowCounters() : {}
    const buckets = [
      {
        label: "Cache misses",
        score: totals[PAIN.cacheMiss] || totals.cacheMisses || 0
      },
      {
        label: "Playback stalls",
        score:
          (totals[PAIN.playbackStall] || 0) +
          Math.max(0, Math.round((totals.videoStallMsTotal || 0) / 1000))
      },
      {
        label: "Predictor blocked",
        score: totals[PAIN.predictorBlocked] || 0
      },
      {
        label: "Speculative denied",
        score: totals[PAIN.speculativeDenied] || 0
      },
      {
        label: "Congestion throttles",
        score: totals[PAIN.congestionThrottle] || 0
      },
      {
        label: "Teleport lane blocked",
        score: totals[PAIN.laneBlocked] || 0
      },
      {
        label: "Prefetch cap waits",
        score: totals[PAIN.prefetchCap] || 0
      },
      {
        label: "Store failures",
        score:
          (totals[PAIN.storeFailed] || 0) +
          (state.telemetry?.chunkStore?.failedStores || 0)
      }
    ].filter((row) => row.score > 0)

    const totalScore = buckets.reduce((sum, row) => sum + row.score, 0)
    if (totalScore <= 0) return null

    return buckets
      .sort((a, b) => b.score - a.score)
      .map((row, index) => {
        const pct = Math.round((row.score / totalScore) * 100)
        return `${index + 1}. ${row.label}: ${pct}% (w=${row.score})`
      })
  }

  function maybeLogObservabilitySummary(force = false) {
    const now = Date.now()
    if (!force && now - lastObservabilityLogAt < OBSERVABILITY_LOG_INTERVAL_MS) {
      return
    }
    const liveLines = buildLiveDecisionLines(now)
    const recent = formatRecentJournal()
    const painLines = buildPainReport()
    if (liveLines.length === 0 && !painLines && !recent) return

    lastObservabilityLogAt = now
    if (liveLines.length > 0 || recent) {
      const body = [...liveLines, recent ? `Recent: ${recent}` : ""]
        .filter(Boolean)
        .join(" | ")
      addLog("INFO", `AegisStream decision journal — ${body}`)
    }
    if (painLines?.length) {
      addLog("INFO", `AegisStream pain report — ${painLines.join(" | ")}`)
    }
  }

  function resetDecisionObservability() {
    journal.length = 0
    lastObservabilityLogAt = 0
    lastSpeculativeDenyLogAt = 0
  }

  function resolveSpeculativeDenyReason(tabId, tabState) {
    if (!state.settings?.speculativePrefetchEnabled) {
      return "setting=off"
    }
    if (
      typeof ns.isSpeculativePredictionEnabled === "function" &&
      !ns.isSpeculativePredictionEnabled()
    ) {
      const conf =
        typeof ns.getPredictionConfidence === "function"
          ? Math.round(ns.getPredictionConfidence() * 100)
          : "?"
      const threshold = Math.round(
        (Number(ns.constants?.SEEK_PREDICTION_SPECULATIVE_THRESHOLD) || 0.75) * 100
      )
      return `confidence=${conf}%<${threshold}%`
    }
    if (typeof ns.isSpeculativePrefetchAllowed === "function" && !ns.isSpeculativePrefetchAllowed()) {
      return "adaptive-mode"
    }
    if (!tabState?.playlistMatrix?.rows?.length) return "no-matrix"
    if (typeof tabState.anchorIndex !== "number" || tabState.anchorIndex < 0) {
      return "no-anchor"
    }
    const congestion =
      tabState.congestionDirectives ||
      (typeof ns.computeCongestionDirectivesForTab === "function"
        ? ns.computeCongestionDirectivesForTab(tabId)
        : null)
    if (congestion && congestion.speculativeAllowed !== true) {
      return `congestion=${congestion.activeTierName || "blocked"}`
    }
    const runway = Number(tabState.bufferRunwaySec)
    if (!Number.isFinite(runway) || runway < Number(ns.constants?.SPECULATIVE_MIN_RUNWAY_SEC || 0)) {
      return `runway=${Number.isFinite(runway) ? runway.toFixed(1) : "?"}s`
    }
    return null
  }

  ns.recordDecision = recordDecision
  ns.notePainCacheMiss = notePainCacheMiss
  ns.notePainPlaybackStall = notePainPlaybackStall
  ns.notePainPredictorBlocked = notePainPredictorBlocked
  ns.notePainSpeculativeDenied = notePainSpeculativeDenied
  ns.notePainCongestionThrottle = notePainCongestionThrottle
  ns.notePainLaneBlocked = notePainLaneBlocked
  ns.notePainPrefetchCap = notePainPrefetchCap
  ns.notePainStoreFailed = notePainStoreFailed
  ns.resolveSpeculativeDenyReason = resolveSpeculativeDenyReason
  ns.buildLiveDecisionLines = buildLiveDecisionLines
  ns.buildPainReport = buildPainReport
  ns.maybeLogObservabilitySummary = maybeLogObservabilitySummary
  ns.resetDecisionObservability = resetDecisionObservability
})()
