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

function collectConsumerProtectedUrls() {
  const protectedSet = new Set()
  for (const [url, entry] of state.inflightPrefetches.entries()) {
    if ((Number(entry?.consumers) || 0) <= 0) continue
    addUrlToProtectedSet(url, protectedSet)
  }
  return protectedSet
}

/** Tier A: playhead guard ring + Layer 4 consumer-attached assets. */
function collectTierAProtectedUrls() {
  const protectedSet = collectGuardRingProtectedUrls()
  for (const url of collectConsumerProtectedUrls()) {
    protectedSet.add(url)
  }
  return protectedSet
}

function collectGuardRingProtectedUrls() {
  const protectedSet = new Set()
  const defaultPast = Math.max(0, Number(constants.CACHE_GUARD_RING_PAST_SEGMENTS) || 2)
  const defaultFuture = Math.max(0, Number(constants.CACHE_GUARD_RING_FUTURE_SEGMENTS) || 12)

  for (const tabState of state.playlistByTab.values()) {
    if (!tabState?.segments?.length || typeof tabState.anchorIndex !== "number") continue
    const seekChurn = isTabInSeekChurnAggressive(tabState)
    const teleportActive = Date.now() < Number(tabState.teleportModeUntil || 0)
    // A tab with a measurably low real hit rate is being widened via
    // resolveAdaptiveHitRateBoost() on the prefetch side — extend the same
    // amount of protection here so those extra fetches aren't reclaimed by
    // eviction before playback ever reaches them (would otherwise show up
    // as wasted fill / "recentlyEvictedMisses").
    const hitRateBoost =
      typeof ns.resolveAdaptiveHitRateBoost === "function" ? ns.resolveAdaptiveHitRateBoost(tabState) : 0
    const past = (seekChurn || teleportActive
      ? Math.max(defaultPast, Number(constants.CACHE_GUARD_RING_SEEK_CHURN_PAST) || 5)
      : defaultPast) + Math.ceil(hitRateBoost / 2)
    const future = (seekChurn || teleportActive
      ? Math.max(defaultFuture, Number(constants.CACHE_GUARD_RING_SEEK_CHURN_FUTURE) || 24)
      : defaultFuture) + hitRateBoost
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

  const ageMs = Date.now() - Number(item.createdAt || 0)
  if (ageMs < 15000) {
    // Protect recently fetched chunks (e.g. from false seeks) by pushing them to the end of the queue.
    // Score gradually rises from -15000 to 0 as they age, so oldest-recent are evicted first if needed.
    return -15000 + ageMs
  }

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
    const temperature =
      typeof ns.calculateSegmentTemperature === "function"
        ? ns.calculateSegmentTemperature(tabState, index)
        : null
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
    const evictionPriority =
      Number.isFinite(temperature) && temperature !== Number.NEGATIVE_INFINITY
        ? -temperature
        : distance - heat * heatBias
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
ns.collectConsumerProtectedUrls = collectConsumerProtectedUrls
ns.collectTierAProtectedUrls = collectTierAProtectedUrls
ns.isUrlGuardRingProtected = isUrlGuardRingProtected
ns.sortEvictionCandidates = sortEvictionCandidates
})()
