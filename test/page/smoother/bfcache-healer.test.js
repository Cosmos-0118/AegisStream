/**
 * Run: node test/page/smoother/bfcache-healer.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const srcDir = path.join(__dirname, "../../../src/page/smoother/navigation")

class FakeEventTarget {
  constructor() {
    this._listeners = []
  }
  addEventListener(type, listener, options) {
    this._listeners.push({ type, listener, options })
  }
  removeEventListener(type, listener, options) {
    this._listeners = this._listeners.filter(
      (entry) => entry.type !== type || entry.listener !== listener
    )
  }
}

const window = new FakeEventTarget()
const sandbox = {
  window,
  self: { AegisPageBridge: { smoother: { isSmootherSkippedHost: () => false } } },
  EventTarget: { prototype: FakeEventTarget.prototype },
  location: { hostname: "example.com" },
  Object,
  console
}
sandbox.self = sandbox

vm.runInContext(fs.readFileSync(path.join(srcDir, "bfcache-healer.js"), "utf8"), vm.createContext(sandbox))

const onUnload = () => {}
window.addEventListener("unload", onUnload)
const migrated = window._listeners.some(
  (entry) => entry.type === "pagehide" && entry.listener === onUnload
)
if (!migrated) {
  throw new Error("unload listener was not migrated to pagehide")
}

const onDirectUnload = () => {}
window.onunload = onDirectUnload
const directMigrated = window._listeners.some(
  (entry) => entry.type === "pagehide" && entry.listener === onDirectUnload
)
if (!directMigrated) {
  throw new Error("window.onunload assignment was not migrated to pagehide")
}

window.onunload = null
const cleared = !window._listeners.some(
  (entry) => entry.type === "pagehide" && entry.listener === onDirectUnload
)
if (!cleared) {
  throw new Error("window.onunload = null did not remove pagehide listener")
}

console.log("bfcache-healer.test.js: ok")
