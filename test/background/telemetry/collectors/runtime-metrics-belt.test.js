/**
 * Run: node test/background/telemetry/collectors/runtime-metrics-belt.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const runtimeMetricsPath = path.join(
  __dirname,
  "../../../../src/background/telemetry/collectors/runtime-metrics.js"
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const noteCalls = []
const sandbox = {
  self: {
    AegisBackground: {
      constants: {
        MAX_TTFB_SAMPLES: 50,
        UMP_HEALTH_LOG_INTERVAL_MS: 30_000
      },
      state: {
        stats: {
          beltLookupMisses: 0,
          beltLookupTimeouts: 0,
          beltLookupRecentlyEvictedMisses: 0,
          beltLookupMissNeverStored: 0
        },
        telemetry: {
          firstByteAll: [],
          firstByteCache: [],
          firstByteNetwork: [],
          chunkStore: {
            successfulStores: 0,
            failedStores: 0,
            totalBytesStored: 0,
            bySource: {}
          },
          logThrottleByKey: new Map(),
          lastUmpHealthLogAt: 0,
          umpHashes: new Set()
        },
        playlistByTab: new Map(),
        umpLookupSeenAt: new Map()
      },
      addLog: () => {},
      noteTabPageUrl: () => {},
      isReactivePrefetchTab: () => false,
      bumpActivity(metric, amount = 1) {
        if (!Number.isFinite(amount)) return
        if (typeof this.state.stats[metric] !== "number") this.state.stats[metric] = 0
        this.state.stats[metric] += amount
      },
      noteRecentlyEvictedMiss(url) {
        noteCalls.push(url)
        if (String(url).includes("evicted")) return { recentlyEvicted: true }
        return null
      }
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(runtimeMetricsPath, "utf8"), vm.createContext(sandbox))

const api = sandbox.self.AegisBackground
const sender = { tab: { id: 7 } }

api.handleRuntimeMetric(
  {
    metricType: "xhr_idb_belt_miss",
    lane: "not-candidate",
    url: "https://cdn.example/video/evicted-seg.ts"
  },
  sender
)
assert(api.state.stats.beltLookupMisses === 1, "belt miss counter should increment")
assert(
  api.state.stats.beltLookupRecentlyEvictedMisses === 1,
  "belt recently evicted counter should increment"
)
assert(noteCalls.length === 1, "belt miss should classify against eviction journal")

api.handleRuntimeMetric(
  {
    metricType: "xhr_idb_belt_miss",
    lane: "lookup-miss",
    url: "https://cdn.example/video/not-counted.ts"
  },
  sender
)
assert(api.state.stats.beltLookupMisses === 2, "lookup-miss lane still counts belt misses")
assert(
  api.state.stats.beltLookupMissNeverStored === 0,
  "lookup-miss lane should not double-classify against background miss path"
)
assert(noteCalls.length === 1, "lookup-miss lane should skip extra eviction classification")

api.handleRuntimeMetric(
  {
    metricType: "xhr_idb_belt_timeout",
    lane: "not-candidate",
    url: "https://cdn.example/video/never-stored.ts"
  },
  sender
)
assert(api.state.stats.beltLookupTimeouts === 1, "belt timeout counter should increment")
assert(
  api.state.stats.beltLookupMissNeverStored === 1,
  "belt timeout should classify never-stored misses"
)

console.log("runtime-metrics-belt.test.js: all assertions passed")
