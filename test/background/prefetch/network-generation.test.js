/**
 * Run: node test/background/prefetch/network-generation.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const genPath = path.join(__dirname, "../../../src/background/prefetch/network-generation.js")

const logs = []
const sandbox = {
  self: {
    AegisBackground: {
      addLog: (_level, msg) => logs.push(msg)
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(genPath, "utf8"), vm.createContext(sandbox))

const {
  bumpNetworkGeneration,
  tryRegisterPrefetchDownload,
  isCurrentNetworkGeneration
} = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const tabState = { networkGeneration: 0, prefetchDownloadRegistry: new Set() }
const gen1 = bumpNetworkGeneration(1, tabState, "test")
assert(gen1 === 1, "first bump should be 1")
assert(tryRegisterPrefetchDownload(tabState, "https://cdn.example.com/a.ts"), "register ok")
assert(
  !tryRegisterPrefetchDownload(tabState, "https://cdn.example.com/a.ts"),
  "duplicate register blocked"
)
bumpNetworkGeneration(1, tabState, "seek")
assert(gen1 !== tabState.networkGeneration, "second bump increments")
assert(
  tryRegisterPrefetchDownload(tabState, "https://cdn.example.com/a.ts"),
  "register allowed after bump"
)
assert(!isCurrentNetworkGeneration(tabState, gen1), "stale generation rejected")

console.log("network-generation.test.js: OK")
