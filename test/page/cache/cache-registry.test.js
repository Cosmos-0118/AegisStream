/**
 * Run: node test/page/cache/cache-registry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mediaKeyPath = path.join(__dirname, "../../../src/page/media/media-cache-key-page.js")
const registryPath = path.join(__dirname, "../../../src/page/cache/cache-registry.js")

const sandbox = { globalThis: {}, URL }
sandbox.self = sandbox.globalThis
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(registryPath, "utf8"), vm.createContext(sandbox))

const ns = sandbox.globalThis.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sharedTail = "ChkAT0wHWFULW0FFclNeUEBKRRAaBVkLXQNGRExxUAhVEE1BFxhZWApa"
const url = `https://use21.playlist.ttvnw.net/v1/segment/Dwdf${sharedTail}`
const invariant = ns.buildMediaInvariantKey(url)

ns.applyCacheRegistrySync({ keys: [invariant], replace: true })
assert(ns.isLikelyCacheHitCandidate(url) === true, "registered key should be a hit candidate")

const otherUrl = `https://use21.playlist.ttvnw.net/v1/segment/Cw0VHUcGQAoCCFscFypKDwdf${sharedTail}`
assert(ns.isLikelyCacheHitCandidate(otherUrl) === true, "rotator URL with same invariant tail should match")

assert(
  ns.isLikelyCacheHitCandidate("https://cdn.example.com/live/seg-999.ts") === false,
  "unknown segment should short-circuit as miss"
)

const intentUrl = "https://cdn.example.com/live/seg-intent.ts"
assert(ns.isLikelyCacheHitCandidate(intentUrl) === false, "intent-only URL should not match before registration")
ns.notePrefetchIntent(intentUrl)
assert(ns.isLikelyCacheHitCandidate(intentUrl) === true, "in-flight intent should enable lookup/collapse")
ns.clearPrefetchIntent(intentUrl)
assert(ns.isLikelyCacheHitCandidate(intentUrl) === false, "cleared intent should disable candidate again")

ns.notePrefetchIntent(intentUrl)
ns.noteLocalCacheKey(intentUrl)
assert(
  ns.isLikelyCacheHitCandidate(intentUrl) === true,
  "stored key should remain a hit candidate after intent clears"
)

console.log("cache-registry.test.js: all assertions passed")
