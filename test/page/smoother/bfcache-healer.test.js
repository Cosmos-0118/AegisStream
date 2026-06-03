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

function NativeWebSocket(url, protocols) {
  this.url = url
  this.protocols = protocols
  this.readyState = NativeWebSocket.CONNECTING
}
NativeWebSocket.prototype = {
  addEventListener() {},
  removeEventListener() {},
  close() {},
  send() {},
  dispatchEvent() {
    return false
  }
}
for (const [key, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
  Object.defineProperty(NativeWebSocket, key, { value, writable: false, configurable: false })
}
window.WebSocket = NativeWebSocket
window.EventSource = function EventSource() {}
window.EventSource.prototype = { addEventListener() {}, close() {} }

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

const WrappedWebSocket = window.WebSocket
if (WrappedWebSocket.CONNECTING !== 0 || WrappedWebSocket.OPEN !== 1) {
  throw new Error("HealingWebSocket should inherit static readyState constants")
}

console.log("bfcache-healer.test.js: ok")
