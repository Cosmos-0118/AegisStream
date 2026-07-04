(() => {
  var ns = (self.AegisBackground ||= {})
  const { constants, state } = ns

  function classifyPrefetchLane(source) {
    const label = String(source || "schedule").toLowerCase()
    if (/teleport|dom-seek|dom-seeked|force-teleport/.test(label)) return "teleport"
    if (/snap|scrub|seek-pred|churn|guard|velocity/.test(label)) return "snapback"
    return "maintenance"
  }

  function isTeleportPriorityLaneActive(tabState, now = Date.now()) {
    if (!tabState) return false
    return now < Number(tabState.teleportPriorityUntil || 0)
  }

  function armTeleportPriorityLane(tabState, targetIndex, now = Date.now()) {
    if (!tabState || typeof targetIndex !== "number") return
    const durationMs = Number(constants.TELEPORT_PRIORITY_LANE_MS) || 3_000
    tabState.teleportPriorityUntil = now + durationMs
    tabState.teleportPriorityIndex = Math.max(0, Math.round(targetIndex))
    tabState.teleportPriorityArmedAt = now
    tabState.teleportLeaseUntil = now + durationMs
    tabState.teleportLeaseTargetIndex = tabState.teleportPriorityIndex
    tabState.isTeleportLeaseActive = true
    if (typeof ns.recordDecision === "function") {
      ns.recordDecision(
        "teleport-lane",
        "armed",
        `focus index ${tabState.teleportPriorityIndex}, duration ${(durationMs / 1000).toFixed(1)}s`
      )
    }
  }

  function activateOrExtendTeleportLease(tabState, targetIndex, now = Date.now()) {
    if (!tabState || typeof targetIndex !== "number") {
      return { extended: false, fresh: false }
    }
    const durationMs = Number(constants.TELEPORT_PRIORITY_LANE_MS) || 3_000
    const leaseUntil = Number(tabState.teleportLeaseUntil || 0)
    const clamped = Math.max(0, Math.round(targetIndex))
    if (tabState.isTeleportLeaseActive && leaseUntil > now) {
      const previous = tabState.teleportLeaseTargetIndex
      tabState.teleportLeaseTargetIndex = clamped
      tabState.teleportTargetIndex = clamped
      tabState.teleportLeaseUntil = now + durationMs
      tabState.teleportModeUntil = now + durationMs
      armTeleportPriorityLane(tabState, clamped, now)
      return { extended: true, fresh: false, previous, target: clamped }
    }
    tabState.isTeleportLeaseActive = true
    tabState.teleportLeaseTargetIndex = clamped
    return { extended: false, fresh: true, target: clamped }
  }

  function countInflightByLane(tabId) {
    const counts = { teleport: 0, snapback: 0, maintenance: 0 }
    for (const inflight of state.inflightPrefetches.values()) {
      if (inflight?.tabId !== tabId) continue
      const lane = inflight.lane || classifyPrefetchLane(inflight.source)
      if (counts[lane] != null) counts[lane] += 1
    }
    return counts
  }

  function resolveLaneCaps(globalCap) {
    const cap = Math.max(1, Number(globalCap) || 1)
    const teleportShare = Number(constants.TELEPORT_LANE_TELEPORT_SHARE) || 0.7
    const snapbackShare = Number(constants.TELEPORT_LANE_SNAPBACK_SHARE) || 0.2
    const teleport = Math.max(1, Math.ceil(cap * teleportShare))
    const snapback = Math.max(1, Math.ceil(cap * snapbackShare))
    const maintenance = Math.max(1, cap - teleport - snapback)
    return { teleport, snapback, maintenance, total: cap }
  }

  function laneHasBudget(tabId, tabState, lane, globalCap) {
    if (!isTeleportPriorityLaneActive(tabState)) return true
    const caps = resolveLaneCaps(globalCap)
    const inflight = countInflightByLane(tabId)
    const maxForLane = caps[lane] || caps.maintenance
    const runwaySec = Number(tabState?.bufferRunwaySec || tabState?.runwaySec || 0)
    if (Number.isFinite(runwaySec) && runwaySec <= Number(constants.BUFFER_RUNWAY_AGGRESSIVE_SEC)) {
      return inflight[lane] < Math.max(maxForLane, caps.teleport)
    }
    return inflight[lane] < maxForLane
  }

  function reorderTargetsForPriorityLane(targets, tabState) {
    if (!isTeleportPriorityLaneActive(tabState) || !tabState?.segments?.length) {
      return targets
    }
    const focus = Number(tabState.teleportPriorityIndex)
    if (!Number.isFinite(focus)) return targets
    const segments = tabState.segments
    return [...targets].sort((urlA, urlB) => {
      const ia = segments.indexOf(urlA)
      const ib = segments.indexOf(urlB)
      const da = ia >= 0 ? Math.abs(ia - focus) : Number.POSITIVE_INFINITY
      const db = ib >= 0 ? Math.abs(ib - focus) : Number.POSITIVE_INFINITY
      return da - db
    })
  }

  /**
   * Byte-aware scheduling: cheap segments first in the batch tail.
   *
   * The head of the batch (nearest the playhead) keeps strict playback order.
   * The remainder is sorted by estimated download cost — segment duration is
   * the proxy for byte size at constant bitrate — so small chunks complete
   * early and convert to visible cache hits while large chunks stream in
   * behind them instead of hogging all sockets up front.
   */
  function reorderTargetsByByteCost(targets, tabState) {
    const headCount = Math.max(1, Number(ns.constants?.BYTE_AWARE_HEAD_SEGMENTS) || 3)
    if (!Array.isArray(targets) || targets.length <= headCount + 1) return targets
    const durations = Array.isArray(tabState?.segmentDurations)
      ? tabState.segmentDurations
      : null
    if (!durations || !tabState?.segments?.length) return targets

    const segments = tabState.segments
    const costOf = (url) => {
      const index = segments.indexOf(url)
      const duration = index >= 0 ? Number(durations[index]) : NaN
      return Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY
    }

    const tail = targets.slice(headCount)
    const knownCosts = tail.map(costOf).filter(Number.isFinite)
    if (knownCosts.length < 2) return targets
    // Uniform playlists (constant segment duration) keep pure playback order.
    if (Math.max(...knownCosts) - Math.min(...knownCosts) < 0.5) return targets

    const sortedTail = [...tail].sort((urlA, urlB) => costOf(urlA) - costOf(urlB))
    return targets.slice(0, headCount).concat(sortedTail)
  }

  ns.classifyPrefetchLane = classifyPrefetchLane
  ns.reorderTargetsByByteCost = reorderTargetsByByteCost
  ns.isTeleportPriorityLaneActive = isTeleportPriorityLaneActive
  ns.armTeleportPriorityLane = armTeleportPriorityLane
  ns.activateOrExtendTeleportLease = activateOrExtendTeleportLease
  ns.countInflightByLane = countInflightByLane
  ns.resolveLaneCaps = resolveLaneCaps
  ns.laneHasBudget = laneHasBudget
  ns.reorderTargetsForPriorityLane = reorderTargetsForPriorityLane
})()
