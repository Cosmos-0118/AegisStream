/**
 * Run: node test/background/telemetry/decision-observability.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const observabilityPath = path.join(
  __dirname,
  "../../../src/background/telemetry/decision-observability.js"
)

const painCalls = []
const sandbox = {
  self: {
    AegisBackground: {
      state: {
        playlistByTab: new Map(),
        activePrefetchTabId: null,
        settings: { prefetchWindow: 8, speculativePrefetchEnabled: true },
        stats: {},
        telemetry: {
          requestCollapse: { hits: 10, savedFetches: 10, savedBytes: 50 * 1024 * 1024 },
          chunkStore: { successfulStores: 100, failedStores: 0 }
        }
      },
      constants: {
        SEEK_PREDICTION_DISABLE_THRESHOLD: 0.35,
        SEEK_PREDICTION_SPECULATIVE_THRESHOLD: 0.75,
        SPECULATIVE_MIN_RUNWAY_SEC: 2
      },
      addLog: () => {},
      bumpActivity: (metric, amount) => {
        painCalls.push({ metric, amount })
      },
      sumWindowCounters: () => ({
        painCacheMiss: 40,
        painPlaybackStall: 20,
        painPredictorBlocked: 10
      }),
      getSeekPredictionSummary: () => ({
        confidence: 0.22,
        hitRate: 0.1,
        enabled: false,
        speculative: false
      })
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(observabilityPath, "utf8"), vm.createContext(sandbox))

const {
  buildLiveDecisionLines,
  buildPainReport,
  notePainCacheMiss,
  recordDecision
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const lines = buildLiveDecisionLines()
assert(lines.some((line) => line.includes("Predictor: OFF")), "journal should explain predictor off")
assert(lines.some((line) => line.includes("Collapse saved")), "journal should include collapse ROI")

const pain = buildPainReport()
assert(pain && pain[0].includes("Cache misses"), "pain report should rank cache misses")

notePainCacheMiss(1)
assert(painCalls.some((c) => c.metric === "painCacheMiss"), "pain bump should fire")

recordDecision("test", "ok", "unit")
assert(buildLiveDecisionLines().length > 0, "decision lines still build after record")

console.log("decision-observability.test.js: all assertions passed")
