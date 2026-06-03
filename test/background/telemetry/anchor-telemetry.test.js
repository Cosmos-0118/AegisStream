/**
 * Run: node test/background/telemetry/anchor-telemetry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const activityPath = path.join(__dirname, "../../../src/background/telemetry/activity-metrics.js")
const authorityPath = path.join(__dirname, "../../../src/background/prefetch/anchor-authority.js")
const telemetryPath = path.join(__dirname, "../../../src/background/telemetry/anchor-telemetry.js")

const sandbox = { self: {}, chrome: {} }
sandbox.globalThis = sandbox
const ctx = vm.createContext(sandbox)

vm.runInContext(fs.readFileSync(constantsPath, "utf8"), ctx)
sandbox.self.AegisBackground.state = {
  stats: sandbox.self.AegisBackground.constants.createInitialStats()
}
vm.runInContext(fs.readFileSync(activityPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(authorityPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(telemetryPath, "utf8"), ctx)

const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

api.resetActivityMetrics()
api.recordAnchorCommit(api.AnchorAuthority.DOM_SEEKED, { teleport: "soft" })
api.recordMonotonicBreakthrough()
api.recordTokenRefreshRetention()
api.recordAnchorDeferred()
api.recordDomSeekSkipped()

const summary = api.getAnchorOwnershipSummary()
assert(summary.anchorCommits.domSeeked === 1, "dom seek commit counted")
assert(summary.teleports.soft === 1, "soft teleport counted")
assert(summary.monotonicBreakthroughs === 1, "monotonic breakthrough counted")
assert(summary.tokenRefreshRetentions === 1, "token retention counted")
assert(summary.anchorDeferred === 1, "deferred counted")
assert(summary.domSeekSkipped === 1, "dom skip counted")

const line = api.formatAnchorOwnershipLine(summary)
assert(line.includes("anchor(net="), "health line includes anchor commits")
assert(line.includes("dom=1"), "health line includes dom count")

console.log("anchor-telemetry.test.js: all assertions passed")
