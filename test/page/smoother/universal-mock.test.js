/**
 * Run: node test/page/smoother/universal-mock.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const srcDir = path.join(__dirname, "../../../src/page/smoother")

const sandbox = {
  window: {},
  globalThis: null
}
sandbox.globalThis = sandbox.window

vm.runInContext(
  fs.readFileSync(path.join(srcDir, "universal-mock-prelude-aggressive.js"), "utf8"),
  vm.createContext(sandbox)
)
vm.runInContext(fs.readFileSync(path.join(srcDir, "universal-mock.js"), "utf8"), vm.createContext(sandbox))

const { window } = sandbox

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(typeof window.mixpanel.people.set_once === "function", "deep mixpanel chain is callable")
window.mixpanel.people.set_once({ plan: "pro" })

assert(typeof window.clarity.initialized !== "undefined", "clarity property read does not throw")
assert("initialized" in window.clarity, "clarity has trap")

assert(typeof window.gtag === "function", "gtag is invokable")
window.gtag("config", "G-TEST")

assert(window.mixpanel.toString() === "", "toString is safe")

console.log("universal-mock.test.js: ok")
