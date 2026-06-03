(() => {
var ns = (self.AegisBackground ||= {})

const STREAM_TYPES = new Set(["hls", "ump"])

function createStreamCounters() {
  return { lookups: 0, hits: 0, misses: 0, warmups: 0, requests: 0 }
}

class MetricsCollector {
  constructor() {
    this.registry = {
      hls: createStreamCounters(),
      ump: createStreamCounters()
    }
  }

  record(streamType, eventType, amount = 1) {
    if (!STREAM_TYPES.has(streamType)) return
    const bucket = this.registry[streamType]
    if (!bucket || typeof bucket[eventType] !== "number") return
    if (!Number.isFinite(amount) || amount === 0) return
    bucket[eventType] += amount
  }

  reset() {
    this.registry.hls = createStreamCounters()
    this.registry.ump = createStreamCounters()
  }

  getSnapshot() {
    const hls = { ...this.registry.hls }
    const ump = { ...this.registry.ump }
    const hlsLookups = hls.lookups || hls.hits + hls.misses + hls.warmups
    const umpLookups = ump.lookups || ump.hits + ump.misses + ump.warmups
    const totalLookups = hlsLookups + umpLookups
    const totalHits = hls.hits + ump.hits
    const hitRatePercent =
      hls.hits + hls.misses + ump.hits + ump.misses > 0
        ? Math.round(
            (totalHits / (hls.hits + hls.misses + ump.hits + ump.misses)) * 100
          )
        : 0
    return {
      hls,
      ump,
      combined: {
        lookups: totalLookups,
        hits: totalHits,
        hitRatePercent,
        hitRateLabel: `${hitRatePercent}%`
      }
    }
  }
}

const metrics = new MetricsCollector()

ns.metrics = metrics
ns.recordStreamMetric = (streamType, eventType, amount) => {
  metrics.record(streamType, eventType, amount)
}
ns.resetMetricsCollector = () => {
  metrics.reset()
}
})()
