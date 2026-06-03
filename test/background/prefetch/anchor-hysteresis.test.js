/**
 * Run: node test/background/prefetch/anchor-hysteresis.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const hysteresisPath = path.join(__dirname, "../../../src/background/prefetch/anchor-hysteresis.js")

const sandbox = { self: {} }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(hysteresisPath, "utf8"), vm.createContext(sandbox))

const { evaluatePassiveAnchorSignal } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const tabState = { anchorIndex: 141 }

let resolved = evaluatePassiveAnchorSignal(tabState, 31, 141)
assert(resolved === 141, "first segment in new neighborhood should hold anchor")
assert(tabState.anchorPendingIndex === 31, "pending neighborhood should be recorded")

resolved = evaluatePassiveAnchorSignal(tabState, 32, 141)
assert(resolved === 32, "monotonic 31 -> 32 should break hysteresis lock")
assert(tabState.anchorPendingIndex === null, "deferral state should clear after breakthrough")

tabState.anchorIndex = 50
tabState.anchorPendingIndex = null
tabState.anchorPendingCount = 0
resolved = evaluatePassiveAnchorSignal(tabState, 51, 50)
assert(resolved === 51, "nearby +1 segment should pass immediately")

console.log("anchor-hysteresis.test.js: all assertions passed")
