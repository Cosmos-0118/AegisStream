/**
 * Run: node test/page/media/swiftstream-url-classify.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mediaKeyPath = path.join(__dirname, "../../../src/page/media/media-cache-key-page.js")
const hlsMediaPath = path.join(__dirname, "../../../src/page/media/hls-media.js")

const sandbox = {
  globalThis: {},
  URL,
  location: { href: "https://animetsu.net/watch/x" }
}
sandbox.self = sandbox.globalThis
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(hlsMediaPath, "utf8"), ctx)

const ns = sandbox.globalThis.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const playlist =
  "https://swiftstream.top/proxy/oppai/kite/DBpHAwAfHAY0FwsCH1cDHV4EQVheBBBFQ3hcXFAXGkdBHQQPUFVXRUtDeFdbVkZMFUwcTgMIHhERAVstVhtb"
const segment =
  "https://swiftstream.top/proxy/oppai/kite/EV9fQAQQXgYnSwcBCw0VHUcGQAoCCFscFypKDwdfChkAT0wHWFULW0FFclNeVUJNRRAaBQgKC1xDFkIiVAsGEE1DQR4DDAgI"

assert(ns.isSwiftStreamPlaylistProxy(playlist), "kite playlist proxy detected")
assert(!ns.isSwiftStreamPlaylistProxy(segment), "transport segment is not playlist proxy")
assert(ns.isPlaylistUrl(playlist), "playlist proxy excluded from chunk intercept")
assert(ns.isLikelyChunk(segment), "transport segment is a chunk")
assert(!ns.isLikelyChunk(playlist), "playlist proxy is not a chunk")

console.log("swiftstream-url-classify.test.js: all assertions passed")
