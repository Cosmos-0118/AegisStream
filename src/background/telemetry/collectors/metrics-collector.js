(() => {
var ns = (self.AegisBackground ||= {})

function createStreamCounters() {
  return { lookups: 0, hits: 0, misses: 0, warmups: 0, requests: 0 }
}

class MetricsCollector {
  constructor() {
    this.registry = {
      hls: createStreamCounters()
    }
  }

  record(streamType, eventType, amount = 1) {
    if (streamType !== "hls") return
    const bucket = this.registry.hls
    if (!bucket || typeof bucket[eventType] !== "number") return
    if (!Number.isFinite(amount) || amount === 0) return
    bucket[eventType] += amount
  }

  reset() {
    this.registry.hls = createStreamCounters()
  }

  getSnapshot() {
    const hls = { ...this.registry.hls }
    const hlsLookups = hls.lookups || hls.hits + hls.misses + hls.warmups
    const hitRatePercent =
      hls.hits + hls.misses > 0
        ? Math.round((hls.hits / (hls.hits + hls.misses)) * 100)
        : 0
    return {
      hls,
      combined: {
        lookups: hlsLookups,
        hits: hls.hits,
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
