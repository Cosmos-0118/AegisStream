(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, stripHash, buildCacheKeyVariants, resolveSegmentIndexInManifest } = ns

function addUrlToProtectedSet(url, protectedSet) {
  const normalized = stripHash(url)
  if (!normalized) return
  protectedSet.add(normalized)
  for (const variant of buildCacheKeyVariants(normalized)) {
    protectedSet.add(variant)
  }
}

/**
 * URLs inside [anchor - past, anchor + future] for every tab with a known anchor.
 */
function isTabInSeekChurnAggressive(tabState) {
  if (!tabState) return false
  const until = Number(tabState.seekChurnAggressiveUntil || 0)
  return Date.now() < until
}

function collectGuardRingProtectedUrls() {
  const protectedSet = new Set()
  const defaultPast = Math.max(0, Number(constants.CACHE_GUARD_RING_PAST_SEGMENTS) || 2)
  const defaultFuture = Math.max(0, Number(constants.CACHE_GUARD_RING_FUTURE_SEGMENTS) || 12)

  for (const tabState of state.playlistByTab.values()) {
    if (!tabState?.segments?.length || typeof tabState.anchorIndex !== "number") continue
    const seekChurn = isTabInSeekChurnAggressive(tabState)
    const teleportActive = Date.now() < Number(tabState.teleportModeUntil || 0)
    const past = seekChurn || teleportActive
      ? Math.max(defaultPast, Number(constants.CACHE_GUARD_RING_SEEK_CHURN_PAST) || 5)
      : defaultPast
    const future = seekChurn || teleportActive
      ? Math.max(defaultFuture, Number(constants.CACHE_GUARD_RING_SEEK_CHURN_FUTURE) || 24)
      : defaultFuture
    const anchor =
      teleportActive && typeof tabState.teleportTargetIndex === "number"
        ? tabState.teleportTargetIndex
        : tabState.anchorIndex
    const start = Math.max(0, anchor - past)
    const end = Math.min(tabState.segments.length - 1, anchor + future)
    for (let index = start; index <= end; index += 1) {
      addUrlToProtectedSet(tabState.segments[index], protectedSet)
    }
  }

  return protectedSet
}

function isUrlGuardRingProtected(url, protectedSet = null) {
  const set = protectedSet || collectGuardRingProtectedUrls()
  const normalized = stripHash(url)
  if (!normalized) return false
  if (set.has(normalized)) return true
  for (const variant of buildCacheKeyVariants(normalized)) {
    if (set.has(variant)) return true
  }
  return false
}

function scoreEvictionCandidate(item, protectedSet) {
  if (!item?.url) return Number.POSITIVE_INFINITY
  if (isUrlGuardRingProtected(item.url, protectedSet)) return Number.POSITIVE_INFINITY

  let bestEvictionPriority = -1
  for (const tabState of state.playlistByTab.values()) {
    if (!tabState?.segments?.length || typeof tabState.anchorIndex !== "number") continue
    const index = resolveSegmentIndexInManifest(item.url, tabState)
    if (typeof index !== "number") continue
    const distance =
      index < tabState.anchorIndex
        ? tabState.anchorIndex - index + 1000
        : index - tabState.anchorIndex
    const heat =
      typeof ns.getTimelineHeatForIndex === "function"
        ? ns.getTimelineHeatForIndex(tabState, index)
        : 0
    const survival =
      typeof ns.computeTimelineSurvivalScore === "function"
        ? ns.computeTimelineSurvivalScore(distance, heat)
        : distance
    if (
      typeof ns.isTimelineHeatProtected === "function" &&
      ns.isTimelineHeatProtected(survival, heat)
    ) {
      return Number.NEGATIVE_INFINITY
    }
    const heatBias = Number(constants.TIMELINE_HEAT_WEIGHT_HISTORICAL) || 4
    const evictionPriority = distance - heat * heatBias
    if (evictionPriority > bestEvictionPriority) bestEvictionPriority = evictionPriority
  }

  return bestEvictionPriority < 0 ? 0 : bestEvictionPriority
}

function sortEvictionCandidates(items, protectedSet) {
  return [...items].sort((a, b) => {
    const scoreA = scoreEvictionCandidate(a, protectedSet)
    const scoreB = scoreEvictionCandidate(b, protectedSet)
    if (scoreA !== scoreB) return scoreB - scoreA
    return Number(a.createdAt || 0) - Number(b.createdAt || 0)
  })
}

ns.collectGuardRingProtectedUrls = collectGuardRingProtectedUrls
ns.isUrlGuardRingProtected = isUrlGuardRingProtected
ns.sortEvictionCandidates = sortEvictionCandidates
})()
