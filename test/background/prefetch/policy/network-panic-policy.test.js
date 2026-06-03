/**
 * Run: node test/background/prefetch/policy/network-panic-policy.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function loadScript(relativePath) {
  const filePath = path.join(__dirname, "../../../..", relativePath)
  vm.runInContext(fs.readFileSync(filePath, "utf8"), vm.createContext(sandbox))
}

const logs = []
const sandbox = {
  self: {
    AegisBackground: {
      state: {
        settings: { prefetchWindow: 6 },
        stats: {},
        telemetry: { firstByteNetwork: [], logThrottleByKey: new Map() }
      },
      constants: {
        PANIC_PREFETCH_WINDOW: 20,
        PANIC_TARGET_RUNWAY_SEC: 180,
        BUFFER_TARGET_RUNWAY_SEC: 60,
        TTFB_PANIC_ENTER_P95_MS: 3000,
        TTFB_PANIC_EXIT_P95_MS: 2400,
        TTFB_PANIC_MIN_NETWORK_SAMPLES: 8
      },
      addLog(_level, message) {
        logs.push(message)
      },
      broadcastSettingsToTabs() {}
    }
  }
}

loadScript("src/background/prefetch/policy/network-panic-policy.js")
const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

for (let i = 0; i < 10; i += 1) {
  api.state.telemetry.firstByteNetwork.push(3200 + i)
}
assert(api.syncNetworkPanicMode() === true, "high network p95 enters panic")
assert(api.isNetworkPanicActive() === true, "panic flag set")
assert(
  api.resolvePanicAdjustedPrefetchWindow(6) === 20,
  "panic raises prefetch window floor to 20"
)

const payload = api.buildSettingsPayloadForTabs()
assert(payload.networkPanicActive === true, "settings payload exposes panic")
assert(payload.bufferTargetRunwaySec === 180, "settings payload uses panic runway target")

api.state.telemetry.firstByteNetwork = []
for (let i = 0; i < 10; i += 1) {
  api.state.telemetry.firstByteNetwork.push(1800 + i)
}
assert(api.syncNetworkPanicMode() === false, "low network p95 exits panic with hysteresis")
assert(api.resolvePanicAdjustedPrefetchWindow(6) === 6, "prefetch window restores after panic")

console.log("network-panic-policy.test.js: ok")
