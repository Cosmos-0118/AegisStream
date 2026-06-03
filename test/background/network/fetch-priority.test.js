/**
 * Run: node test/background/network/fetch-priority.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const priorityPath = path.join(__dirname, "../../../src/background/network/fetch-priority.js")

const sandbox = { self: {} }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(priorityPath, "utf8"), vm.createContext(sandbox))

const { resolveFetchPriority, isSpeculativeFetchSource } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(isSpeculativeFetchSource("prefetch-video"), "prefetch-video is speculative")
assert(resolveFetchPriority({ source: "prefetch-video" }) === "low", "prefetch uses low priority")
assert(
  resolveFetchPriority({ source: "prefetch-video", isScrubbingTrainActive: true }) === "high",
  "scrub emergency uses high"
)
assert(resolveFetchPriority({ source: "player-intercept" }) === "auto", "player uses auto")

console.log("fetch-priority.test.js: all assertions passed")
