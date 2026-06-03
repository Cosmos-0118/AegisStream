/**
 * Page-world mirror of background manifest sequence helpers (MAIN world).
 */
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self
  const ns = (root.AegisPageBridge ||= {})

  function getManifestUrlSignature(url) {
    if (typeof url !== "string" || !url) return null
    try {
      const parsed = new URL(url, location.href)
      return `${parsed.origin}${parsed.pathname}`
    } catch {
      const stripped = url.split("#")[0].split("?")[0]
      return stripped || null
    }
  }

  function estimateManifestIndexFromTime(currentTimeSec, segmentDurations, options = {}) {
    const time = Number(currentTimeSec)
    if (!Number.isFinite(time) || time < 0) return null
    const durations = Array.isArray(segmentDurations) ? segmentDurations : []
    const fallback = Number(options.fallbackSegmentDurationSec) || 4

    if (durations.length > 0) {
      let elapsed = 0
      for (let index = 0; index < durations.length; index += 1) {
        const raw = durations[index]
        const segmentDuration = Number.isFinite(raw) && raw > 0 ? raw : fallback
        if (time < elapsed + segmentDuration) return index
        elapsed += segmentDuration
      }
      return Math.max(0, durations.length - 1)
    }

    const totalDuration = Number(options.totalDurationSec)
    const segmentCount = Number(options.segmentCount)
    if (
      Number.isFinite(totalDuration) &&
      totalDuration > 0 &&
      Number.isFinite(segmentCount) &&
      segmentCount > 0
    ) {
      const ratio = Math.min(1, time / totalDuration)
      return Math.min(segmentCount - 1, Math.max(0, Math.floor(ratio * segmentCount)))
    }

    return null
  }

  ns.getManifestUrlSignature = getManifestUrlSignature
  ns.estimateManifestIndexFromTime = estimateManifestIndexFromTime
})()
