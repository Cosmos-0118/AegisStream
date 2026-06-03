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

  ns.classifyPrefetchLane = classifyPrefetchLane
  ns.isTeleportPriorityLaneActive = isTeleportPriorityLaneActive
  ns.armTeleportPriorityLane = armTeleportPriorityLane
  ns.activateOrExtendTeleportLease = activateOrExtendTeleportLease
  ns.countInflightByLane = countInflightByLane
  ns.resolveLaneCaps = resolveLaneCaps
  ns.laneHasBudget = laneHasBudget
  ns.reorderTargetsForPriorityLane = reorderTargetsForPriorityLane
})()
