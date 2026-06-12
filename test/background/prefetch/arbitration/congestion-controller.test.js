/**
 * Run: node test/background/prefetch/arbitration/congestion-controller.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const root = path.join(__dirname, "../../../..")

function loadScript(relativePath) {
  vm.runInContext(
    fs.readFileSync(path.join(root, relativePath), "utf8"),
    vm.createContext(sandbox)
  )
}

const sandbox = {
  self: {},
  console,
  Date,
  Math,
  Set,
  Map,
  Array,
  Object,
  Number,
  String
}
sandbox.self = sandbox

loadScript("src/background/config/constants.js")
loadScript("src/background/state/runtime-state.js")
loadScript("src/background/prefetch/policy/network-panic-policy.js")
loadScript("src/background/prefetch/arbitration/congestion-controller.js")

const api = sandbox.self.AegisBackground
const { state } = api

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

state.settings.prefetchWindow = 8
state.stats.networkFirstByteP95Ms = 40
state.stats.requestFirstByteP95Ms = 40

const eliteTab = {
  bufferRunwaySec: 35,
  bufferTier: "idle",
  scrubSnapBackUntil: 0
}
const elite = api.computeCongestionDirectives(state.stats, eliteTab, 8)
assert(elite.activeTierName === "ELITE", "fast network should be ELITE")
assert(elite.prefetchRadius === 16, `elite radius expected 16, got ${elite.prefetchRadius}`)
assert(elite.maxInflight === 12, "elite inflight cap")
assert(elite.speculativeAllowed === true, "elite should allow speculative")
assert(elite.speculativeSegmentsAhead === 2, "elite speculative ahead")

state.stats.networkFirstByteP95Ms = 320
const congested = api.computeCongestionDirectives(state.stats, eliteTab, 8)
assert(congested.activeTierName === "CONGESTED", "320ms should be CONGESTED")
assert(congested.maxInflight === 5, "congested inflight cap")
assert(congested.speculativeAllowed === false, "congested blocks speculative")

const scrubTab = {
  bufferRunwaySec: 10,
  bufferTier: "aggressive",
  scrubSnapBackUntil: Date.now() + 60_000
}
state.stats.networkFirstByteP95Ms = 600
const scrub = api.computeCongestionDirectives(state.stats, scrubTab, 8)
assert(scrub.prefetchRadius >= 15, "scrub guard should floor radius to 15")
assert(scrub.prefetchRadius <= 20, "scrub guard should cap radius at 20")

state.playlistByTab.set(99, { ...scrubTab })
const cap = api.resolveCongestionGlobalCap(99)
assert(
  cap >= 8,
  `scrub guard should floor panic inflight during low buffer, got ${cap}`
)

console.log("congestion-controller.test.js: all assertions passed")
