/**
 * Run: node test/background/telemetry/collectors/metrics-aggregator.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const aggregatorPath = path.join(
  __dirname,
  "../../../../src/background/telemetry/collectors/metrics-aggregator.js"
)

const sessionStore = new Map()

const sandbox = {
  self: { AegisBackground: { state: { telemetry: {} }, addLog: () => {} } },
  chrome: {
    storage: {
      session: {
        async get(key) {
          const k = typeof key === "string" ? key : "aegis_history_rollups"
          return { [k]: sessionStore.get(k) || [] }
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v)
        }
      }
    }
  }
}
sandbox.self = sandbox
vm.runInContext(fs.readFileSync(aggregatorPath, "utf8"), vm.createContext(sandbox))

const ns = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function runAsyncTests() {
  sessionStore.clear()
  const rollup = ns.flushMetricsRollup(false)
  await new Promise((r) => setTimeout(r, 10))
  const history = await ns.getMetricsRollupHistory()
  assert(history.length === 1, "rollup should sink to session storage")
  assert(history[0].speculative_hits === rollup.speculative_hits, "sunk payload matches flush")

  for (let i = 0; i < 125; i += 1) {
    ns.flushMetricsRollup(false)
    await new Promise((r) => setTimeout(r, 0))
  }
  const trimmed = await ns.getMetricsRollupHistory()
  assert(trimmed.length === 120, "history should cap at 120 entries, got " + trimmed.length)
}

ns.recordSpeculationAllocated({
  tab_id: 1,
  confidence: 0.52,
  buffer_runway_sec: 45.7,
  calculated_score: 0.38,
  assigned_tier: "CONSERVATIVE_LQ",
  target_segment_index: 62,
  network_tier: "NOMINAL"
})

const resolved = ns.tryResolveSpeculationAtSegment(1, 62, {
  was_hit: true,
  bitrate_tier_used: "LQ",
  resolve_source: "chunk-observed"
})
assert(resolved?.was_hit === true, "speculation should resolve as hit")
assert(resolved?.time_saved_ms >= 0, "time_saved_ms should be non-negative")

ns.recordScrubPrewarmScheduled()
ns.recordScrubPrewarmSkippedDedup()
ns.recordKalmanStateReset()
ns.recordPlaybackStallForRollup(420)

const rollup = ns.flushMetricsRollup(false)
assert(rollup.speculative_allocated === 1, "allocated counter")
assert(rollup.speculative_hits === 1, "hit counter")
assert(rollup.scrub_prewarm_total === 1, "scrub prewarm counter")
assert(rollup.z_axis_kalman_resets === 1, "kalman reset counter")
assert(rollup.total_stall_duration_ms === 420, "stall ms rollup")
assert(rollup.efficiency_ratio === 1, "efficiency ratio 100%")

runAsyncTests()
  .then(() => {
    console.log("metrics-aggregator.test.js: all passed")
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
