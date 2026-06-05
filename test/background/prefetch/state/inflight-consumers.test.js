/**
 * Run: node test/background/prefetch/state/inflight-consumers.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function load(relativePath) {
  const fullPath = path.join(__dirname, "../../../../src", relativePath)
  vm.runInContext(fs.readFileSync(fullPath, "utf8"), vm.createContext(sandbox))
}

const sandbox = {
  self: {},
  AegisBackground: {
    constants: {},
    state: {
      inflightPrefetches: new Map()
    },
    stripHash: (url) => (typeof url === "string" ? url.split("#")[0] : null),
    resolvePrefetchCoalesceKey: (url) => url,
    addLog: () => {}
  }
}
sandbox.self.AegisBackground = sandbox.AegisBackground

load("background/prefetch/state/inflight-consumers.js")

const ns = sandbox.AegisBackground
const { state } = ns

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const url = "https://cdn.example.com/seg-42.ts"
state.inflightPrefetches.set(url, {
  tabId: 1,
  startedAt: Date.now(),
  consumers: 0
})

assert(ns.attachInflightConsumer(url, 1) === 1, "attach should increment consumers")
assert(ns.isInflightAbortLocked(url, 1) === true, "abort should be locked after attach")

assert(ns.tryReleaseInflightEntry(url) === false, "release should defer while consumers attached")
assert(state.inflightPrefetches.has(url) === true, "entry should remain while locked")

assert(ns.releaseInflightConsumer(url, 1) === 0, "release should decrement consumers")
assert(ns.isInflightAbortLocked(url, 1) === false, "abort lock should clear after release")
assert(
  state.inflightPrefetches.has(url) === false,
  "deferred entry should be removed once the last consumer detaches"
)

state.inflightPrefetches.set(url, { tabId: 1, startedAt: Date.now(), consumers: 0 })
assert(ns.tryReleaseInflightEntry(url) === true, "release should succeed when no consumers are attached")
assert(state.inflightPrefetches.has(url) === false, "entry should be removed after safe release")

console.log("inflight-consumers.test.js: all assertions passed")
