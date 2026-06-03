/**
 * Run: node test/background/prefetch/anchor-authority.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const authorityPath = path.join(__dirname, "../../../src/background/prefetch/anchor-authority.js")

const sandbox = { self: {} }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(authorityPath, "utf8"), vm.createContext(sandbox))

const { evaluateAuthorityCommit, AnchorAuthority } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const tabState = { hasAnchor: true, anchorIndex: 141, lastDomTeleportAt: 0 }

let decision = evaluateAuthorityCommit(tabState, 140, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "small DOM seek should be ignored")
assert(decision.reason === "dom-seek-below-min-jump", "small DOM seek reason")

decision = evaluateAuthorityCommit(tabState, 31, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "large DOM seek should be allowed")
assert(decision.purgeQueues === true, "141 -> 31 should purge queues")

tabState.lastDomTeleportAt = Date.now()
decision = evaluateAuthorityCommit(tabState, 20, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === false, "DOM seek inside cooldown should be ignored")
assert(decision.reason === "dom-seek-cooldown", "cooldown reason")

tabState.lastDomTeleportAt = 0
tabState.anchorIndex = 50
tabState.hasAnchor = true
decision = evaluateAuthorityCommit(tabState, 65, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "moderate DOM seek allowed")
assert(decision.purgeQueues === false, "15-segment jump should retain overlap")

tabState.anchorIndex = undefined
tabState.hasAnchor = false
decision = evaluateAuthorityCommit(tabState, 14, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "first DOM anchor allowed")
assert(decision.purgeQueues === false, "first DOM anchor should not purge queues")

const scrubState = {
  hasAnchor: true,
  anchorIndex: 40,
  lastDomTeleportAt: Date.now(),
  scrubbingTrainUntil: Date.now() + 5_000
}
decision = evaluateAuthorityCommit(scrubState, 43, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "scrubbing train allows small DOM seek")
assert(decision.purgeQueues === true, "scrubbing train should hard-purge on every anchor step")

decision = evaluateAuthorityCommit(scrubState, 46, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "scrubbing train allows moderate DOM seek")
assert(decision.purgeQueues === true, "scrubbing train should hard-purge on every anchor step")
assert(decision.reason === null, "no skip reason during scrubbing train")

scrubState.anchorIndex = 46
decision = evaluateAuthorityCommit(scrubState, 46, AnchorAuthority.DOM_SEEKED)
assert(decision.allow === true, "scrubbing train bypasses DOM cooldown on repeat")
assert(decision.purgeQueues === false, "duplicate scrub target should not purge (jump=0)")

console.log("anchor-authority.test.js: all assertions passed")
