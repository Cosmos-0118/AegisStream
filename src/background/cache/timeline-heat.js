(() => {
  var ns = (self.AegisBackground ||= {})
  const { constants, resolveSegmentIndexInManifest } = ns

  function playlistByTab() {
    return ns.state?.playlistByTab
  }

  function heatMapForTab(tabState) {
    if (!tabState) return null
    if (!(tabState.timelineHeat instanceof Map)) {
      tabState.timelineHeat = new Map()
    }
    return tabState.timelineHeat
  }

  function pruneHeatMap(map) {
    const maxEntries = Number(constants.TIMELINE_HEAT_MAX_MAP_ENTRIES) || 400
    if (map.size <= maxEntries) return
    const ranked = [...map.entries()].sort(
      (a, b) => Number(a[1]?.lastAt || 0) - Number(b[1]?.lastAt || 0)
    )
    const removeCount = map.size - maxEntries
    for (let i = 0; i < removeCount; i += 1) {
      map.delete(ranked[i][0])
    }
  }

  function recordTimelineHeat(tabId, segmentIndex, weight = 1) {
    if (!Number.isFinite(tabId) || !Number.isFinite(segmentIndex)) return
    const tabState = playlistByTab()?.get(tabId)
    const map = heatMapForTab(tabState)
    if (!map) return
    const bump = Math.max(0, Number(weight) || 0)
    if (bump <= 0) return
    const bucket = map.get(segmentIndex) || { hits: 0, lastAt: 0 }
    bucket.hits += bump
    bucket.lastAt = Date.now()
    map.set(segmentIndex, bucket)
    pruneHeatMap(map)
  }

  function getTimelineHeatForIndex(tabState, segmentIndex) {
    if (!tabState?.timelineHeat || !Number.isFinite(segmentIndex)) return 0
    const bucket = tabState.timelineHeat.get(segmentIndex)
    if (!bucket) return 0
    const hits = Number(bucket.hits) || 0
    const cap = Number(constants.TIMELINE_HEAT_HIT_CAP) || 12
    return Math.min(cap, hits)
  }

  function getTimelineHeatForUrl(url, tabState = null) {
    if (!url) return 0
    const map = playlistByTab()
    const states = tabState ? [tabState] : map ? map.values() : []
    let maxHeat = 0
    for (const ts of states) {
      if (!ts?.segments?.length) continue
      const index = resolveSegmentIndexInManifest(url, ts)
      if (typeof index !== "number") continue
      maxHeat = Math.max(maxHeat, getTimelineHeatForIndex(ts, index))
    }
    return maxHeat
  }

  /**
   * Survival score S = (D * w_d) + (H * w_h). Higher S = keep longer in IndexedDB.
   */
  function computeTimelineSurvivalScore(distance, heat) {
    const wD = Number(constants.TIMELINE_HEAT_WEIGHT_DISTANCE) || 1
    const wH = Number(constants.TIMELINE_HEAT_WEIGHT_HISTORICAL) || 4
    const D = Math.max(0, Number(distance) || 0)
    const H = Math.max(0, Number(heat) || 0)
    return D * wD + H * wH
  }

  function isTimelineHeatProtected(survivalScore, heat) {
    const minHeat = Number(constants.TIMELINE_HEAT_PROTECT_MIN_HITS) || 4
    const H = Math.max(0, Number(heat) || 0)
    if (H >= minHeat) return true
    const threshold = Number(constants.TIMELINE_HEAT_HOT_THRESHOLD) || 8
    const S = Math.max(0, Number(survivalScore) || 0)
    return H > 0 && S >= threshold
  }

  ns.recordTimelineHeat = recordTimelineHeat
  ns.getTimelineHeatForIndex = getTimelineHeatForIndex
  ns.getTimelineHeatForUrl = getTimelineHeatForUrl
  ns.computeTimelineSurvivalScore = computeTimelineSurvivalScore
  ns.isTimelineHeatProtected = isTimelineHeatProtected
})()
