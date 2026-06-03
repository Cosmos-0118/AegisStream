/**
 * Run: node test/page/shared/cache-registry.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mediaKeyPath = path.join(__dirname, "../../../src/page/shared/media-cache-key-page.js")
const registryPath = path.join(__dirname, "../../../src/page/shared/cache-registry.js")

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

console.log("cache-registry.test.js: all assertions passed")
