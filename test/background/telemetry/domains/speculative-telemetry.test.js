/**
 * Run: node test/background/telemetry/speculative-telemetry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function loadBackground(modules) {
  const sandbox = {
    self: {},
    URL: global.URL,
    URLSearchParams: global.URLSearchParams,
    chrome: {}
  }
  const ctx = vm.createContext(sandbox)
  for (const file of modules) {
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx)
  }
  return sandbox.self.AegisBackground
}

const root = path.join(__dirname, "../../..")
const api = loadBackground([
  path.join(root, "src/background/config/constants.js"),
  path.join(root, "src/background/state/runtime-state.js"),
  path.join(root, "src/background/media/cache-keys.js"),
  path.join(root, "src/background/telemetry/activity-metrics.js"),
  path.join(root, "src/background/telemetry/speculative-telemetry.js")
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

api.state.settings.speculativePrefetchEnabled = true
api.resetSpeculativeTelemetry()

api.registerSpeculativePrefetch({
  url: "https://cdn.example.com/high/seg5.ts?sig=a",
  tabId: 1,
  source: "speculative-rung",
  fromRung: "720p",
  toRung: "1080p"
})

assert(
  (api.state.stats.speculativePrefetchStarted || 0) >= 1,
  "started counted"
)

api.recordSpeculativeCompleted("https://cdn.example.com/high/seg5.ts?sig=a", 500_000, true)
assert(api.state.stats.speculativePrefetchCompleted === 1, "completed counted")
assert(api.state.stats.speculativeBytesDownloaded === 500_000, "downloaded bytes tracked")

api.recordSpeculativeUsed("https://cdn.example.com/high/seg5.ts?sig=b", 500_000, 1)
assert(api.state.stats.speculativePrefetchUsed === 1, "used counted")
assert(api.state.stats.speculativeBytesConsumed === 500_000, "consumed bytes tracked")

const summary = api.getSpeculativeTelemetrySummary()
assert(summary.bytesHitRatePercent === 100, "100% bytes hit rate in fixture")
assert(summary.countHitRatePercent === 100, "100% count hit rate in fixture")

for (let i = 0; i < 30; i += 1) {
  const url = `https://cdn.example.com/waste/seg${i}.ts`
  api.registerSpeculativePrefetch({ url, source: "speculative-rung", fromRung: "a", toRung: "b" })
  api.recordSpeculativeCompleted(url, 200_000, true)
}

const lowHitSummary = api.getSpeculativeTelemetrySummary()
assert(
  lowHitSummary.adaptiveMode === "minimal" || lowHitSummary.adaptiveMode === "reduced",
  `low hit rate scales back (mode=${lowHitSummary.adaptiveMode})`
)
assert(
  (lowHitSummary.bytesHitRatePercent || 100) < 40,
  "bytes hit rate should fall with mostly unused speculative data"
)

console.log("speculative-telemetry.test.js: ok")
