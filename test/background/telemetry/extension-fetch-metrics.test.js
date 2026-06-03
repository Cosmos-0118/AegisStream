/**
 * Run: node test/background/telemetry/extension-fetch-metrics.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function loadScript(relativePath) {
  const filePath = path.join(__dirname, "../../..", relativePath)
  vm.runInContext(fs.readFileSync(filePath, "utf8"), vm.createContext(sandbox))
}

const sandbox = {
  self: {
    AegisBackground: {
      state: {
        stats: {
          extensionFetchStarted: 0,
          extensionFetchCompleted: 0,
          extensionFetchAborted: 0,
          extensionFetchFailed: 0
        },
        telemetry: { extensionFetchBySource: {}, logThrottleByKey: new Map() }
      },
      addLog() {},
      bumpActivity() {}
    }
  }
}

loadScript("src/background/config/constants.js")
loadScript("src/background/state/runtime-state.js")
loadScript("src/background/telemetry/extension-fetch-metrics.js")
const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(api.isExpectedAbortError({ name: "AbortError" }), "AbortError is expected")
assert(!api.isExpectedAbortError({ name: "TypeError" }), "TypeError is unexpected")

api.bumpExtensionFetchLifecycle("player-fetch", "started")
api.bumpExtensionFetchLifecycle("player-fetch", "aborted")
assert(api.state.stats.extensionFetchStarted === 1, "started counter increments")
assert(api.state.stats.extensionFetchAborted === 1, "aborted counter increments")
assert(
  api.formatExtensionFetchMetricsLine().includes("started=1") &&
    api.formatExtensionFetchMetricsLine().includes("aborted=1"),
  "metrics line includes lifecycle totals"
)

console.log("extension-fetch-metrics.test.js: ok")
