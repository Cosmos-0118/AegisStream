/**
 * Run: node test/background/telemetry/collectors/inflight-accounting.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const accountingPath = path.join(
  __dirname,
  "../../../../src/background/telemetry/collectors/inflight-accounting.js"
)

const sandbox = {
  self: {
    AegisBackground: {
      state: {
        inflightPrefetches: new Map()
      },
      addLog: () => {}
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(accountingPath, "utf8"), vm.createContext(sandbox))

const { attachInflightCategory, auditInflightAccounting } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const map = sandbox.self.AegisBackground.state.inflightPrefetches
map.set("a", attachInflightCategory({ tabId: 1, source: "rescue-lane" }))
map.set("b", attachInflightCategory({ tabId: 1, source: "speculative-rung" }))
map.set("c", attachInflightCategory({ tabId: 1, source: "teleport-mode", lane: "teleport" }))
map.set("d", attachInflightCategory({ tabId: 1, source: "scrub-velocity-prewarm", lane: "snapback" }))

const audit = auditInflightAccounting()
assert(audit.ok, "category sum must equal map size")
assert(audit.counts.rescue === 1, "rescue counted")
assert(audit.counts.speculative === 1, "speculative counted")
assert(audit.counts.playback === 1, "playback counted")
assert(audit.counts.prefetch === 1, "prefetch counted")

console.log("inflight-accounting.test.js: all assertions passed")
