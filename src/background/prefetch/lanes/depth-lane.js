(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

/**
 * Depth lane — build cache runway while the network is good.
 *
 * Every widening rule in resolveEffectivePrefetchWindow is *reactive*: the
 * window grows only once bufferRunwaySec has fallen to the aggressive (15s) or
 * emergency (5s) threshold. At a healthy runway every boost is inactive, so the
 * window sits at its base and the cache converges to that fixed lead and stops.
 *
 * Measured over one 10.7-minute session: 89 of 99 delegations were a single
 * segment, and the scheduler's own trace says why —
 * `{"targets":10,"blockedCached":9,"uncached":1}`. The batcher was working
 * perfectly against a window only ten segments wide. Runway held at 20-30s the
 * entire time and never grew: prefetch exactly matched playback.
 *
 * That is inverted. Depth is what survives a slowdown, and it can only be built
 * *before* the slowdown, using headroom that exists only while the buffer is
 * healthy. By the time the reactive rules fire, the bandwidth needed to act on
 * them is already gone.
 *
 * So this lane leaves the urgent window exactly as it is — it never competes
 * with it — and extends the cache ahead of the playhead only from a standing
 * start: when the entire urgent window is already cached, nothing is in flight,
 * and the buffer is healthy. It reuses schedulePrefetch wholesale via
 * prefetchWindowOverride so every existing guard (in-flight tracking, failure
 * cooldowns, lane limits, duplicate suppression, delegation, metrics) applies
 * unchanged.
 */

const DEFAULT_SEGMENT_SEC = 4

/** Mean of the leading segment durations, falling back to a typical HLS target. */
function estimateSegmentDurationSec(tabState) {
  const durations = tabState?.segmentDurations
  if (Array.isArray(durations) && durations.length) {
    let total = 0
    let count = 0
    for (const value of durations) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) continue
      total += n
      count += 1
      if (count >= 50) break
    }
    if (count > 0) return total / count
  }
  return DEFAULT_SEGMENT_SEC
}

/**
 * How many segments ahead the cache should reach, or 0 when depth filling is
 * not appropriate right now.
 *
 * The share cap is the load-bearing guard. Depth is only worth building if it
 * survives to be used, and the cache evicts by playback distance — so a depth
 * target large enough to fill the cache would evict its own far end, and could
 * start evicting near-playhead segments, making the hit rate *worse* than doing
 * nothing. Bounding depth to a fixed share of maxEntries makes that impossible
 * by construction, with no live cache measurement to be stale or race.
 */
function resolveDepthWindow(tabState, remaining, urgentWindow) {
  const targetSec = Number(constants.PREFETCH_DEPTH_TARGET_SEC) || 180
  const segmentSec = estimateSegmentDurationSec(tabState)
  const bySeconds = Math.ceil(targetSec / Math.max(0.5, segmentSec))

  const maxEntries = Number(state.cachePolicy?.maxEntries) || 500
  const share = Number(constants.PREFETCH_DEPTH_CACHE_SHARE) || 0.5
  const byCacheShare = Math.floor(maxEntries * share)

  const hardCap = Number(constants.PREFETCH_DEPTH_MAX_SEGMENTS) || 120

  const depth = Math.min(bySeconds, byCacheShare, hardCap, remaining)
  // Only worth a pass if it actually reaches past what the urgent window covers.
  return depth > urgentWindow ? depth : 0
}

/** Playback states where fetching far ahead is likely to be thrown away. */
function isPlaybackUnsettled(tabState) {
  if (typeof ns.isTabInRapidSeek === "function" && ns.isTabInRapidSeek(tabState)) return true
  if (typeof ns.isTabInScrubbingTrain === "function" && ns.isTabInScrubbingTrain(tabState)) return true
  if (typeof ns.isTabInSeekChurnAggressive === "function" && ns.isTabInSeekChurnAggressive(tabState)) return true
  if (typeof ns.isTabInVariantSwitchGrace === "function" && ns.isTabInVariantSwitchGrace(tabState)) return true
  if (typeof ns.isTabInTeleportMode === "function" && ns.isTabInTeleportMode(tabState)) return true
  return false
}

/**
 * Called from schedulePrefetch when a pass found every target already cached.
 * That is precisely the standing start this lane wants, and it is the state the
 * scheduler spent almost the whole measured session in.
 */
ns.maybeScheduleDepthFill = function maybeScheduleDepthFill(tabId, tabState, segments, startIndex, context = {}) {
  // Temporary diagnostic: depthFillPasses has been observed stuck at 0 for
  // entire sessions where this function is reached dozens of times (the "All
  // N already cached" call site), so at least one of the guards below always
  // declines. Logging the specific reason (DEBUG-only) lets a live session
  // pinpoint which one without guessing. Remove once diagnosed.
  //
  // Throttled per tab: this function is now also called from every successful
  // prefetch completion (prefetch-tracking.js), not just the rare all-cached
  // branch, so an unthrottled log here would dominate the DEBUG ring buffer
  // and push out the ERROR/WARN lines the same live session needs.
  const declineDepthFill = (reason, details) => {
    const now = Date.now()
    const throttleMs = Number(constants.PREFETCH_LOG_THROTTLE_MS) || 5_000
    if (now - Number(tabState?.lastDepthDeclineLogAt || 0) >= throttleMs) {
      if (tabState) tabState.lastDepthDeclineLogAt = now
      addLog("DEBUG", `Depth fill declined on tab ${tabId}: ${reason}${details ? ` (${details})` : ""}`)
    }
    return false
  }

  if (!state.settings?.enabled || !state.settings?.prefetchEnabled) return declineDepthFill("prefetch disabled")
  if (constants.PREFETCH_DEPTH_ENABLED === false) return declineDepthFill("PREFETCH_DEPTH_ENABLED=false")
  if (!tabState || !Array.isArray(segments) || !segments.length) return declineDepthFill("no tabState/segments")
  if (!Number.isFinite(startIndex) || startIndex < 0) return declineDepthFill("invalid startIndex", `startIndex=${startIndex}`)
  // resolveEffectivePrefetchWindow() returns 0 for reactive-prefetch tabs, but
  // that guard lives there, not in schedulePrefetch itself — this call site is
  // reached from a completion handler, not through the normal request path
  // that would otherwise filter reactive tabs out before ever reaching here.
  if (typeof ns.isReactivePrefetchTab === "function" && ns.isReactivePrefetchTab(tabId)) return declineDepthFill("reactive prefetch tab")

  // Never fight the urgent lane for bandwidth.
  if (typeof ns.isPrefetchBlocked === "function" && ns.isPrefetchBlocked(tabState)) return declineDepthFill("prefetch blocked")
  if (isPlaybackUnsettled(tabState)) return declineDepthFill("playback unsettled")

  // A healthy, *known* runway is the licence to spend bandwidth on the future.
  // When the runway is unknown we cannot tell whether the player is about to
  // need that bandwidth itself, so we decline rather than guess.
  const runway = Number(tabState.bufferRunwaySec)
  const minRunway = Number(constants.PREFETCH_DEPTH_MIN_RUNWAY_SEC) || 15
  if (!Number.isFinite(runway) || runway < minRunway) return declineDepthFill("runway below minimum", `runway=${runway}, min=${minRunway}`)

  // Standing start only: if anything is in flight, the urgent lane is working
  // and depth waits its turn.
  const globalInflight =
    typeof ns.countGlobalInflightPrefetches === "function" ? ns.countGlobalInflightPrefetches() : 0
  if (globalInflight > 0) return declineDepthFill("global inflight > 0", `globalInflight=${globalInflight}`)

  const now = Date.now()
  const cooldownMs = Number(constants.PREFETCH_DEPTH_COOLDOWN_MS) || 1_500
  const sinceLast = now - Number(tabState.lastDepthFillAt || 0)
  if (sinceLast < cooldownMs) return declineDepthFill("cooldown active", `sinceLast=${sinceLast}ms, cooldown=${cooldownMs}ms`)

  const remaining = segments.length - startIndex
  const urgentWindow = Number(context.urgentWindow) || 0
  const depthWindow = resolveDepthWindow(tabState, remaining, urgentWindow)
  if (depthWindow <= 0) {
    return declineDepthFill(
      "depthWindow <= urgentWindow",
      `remaining=${remaining}, urgentWindow=${urgentWindow}, segments.length=${segments.length}, startIndex=${startIndex}`
    )
  }

  tabState.lastDepthFillAt = now
  addLog(
    "DEBUG",
    `Depth fill on tab ${tabId}: extending window ${urgentWindow} -> ${depthWindow} ` +
      `(runway=${runway.toFixed(1)}s, from index ${startIndex})`
  )
  if (typeof ns.bumpActivity === "function") ns.bumpActivity("depthFillPasses", 1)

  // force:true — the duplicate-schedule guard exists to stop the urgent lane
  // re-running the same short window, and would otherwise suppress this pass
  // for arriving at the same startIndex it just declined.
  void ns.schedulePrefetch(tabId, segments, startIndex, {
    source: "depth-fill",
    force: true,
    prefetchWindowOverride: depthWindow,
    priority: "low"
  })
  return true
}

ns.isDepthFillSource = function isDepthFillSource(source) {
  return String(source || "") === "depth-fill"
}
})()
