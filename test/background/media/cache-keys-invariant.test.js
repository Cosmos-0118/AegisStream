/**
 * Run: node test/background/media/cache-keys-invariant.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const mediaKeyPath = path.join(__dirname, "../../../src/shared/media-cache-key.js")
const cacheKeysPath = path.join(__dirname, "../../../src/background/media/cache-keys.js")

const sandbox = { self: {}, URL }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(cacheKeysPath, "utf8"), vm.createContext(sandbox))

const { buildCacheKeyVariants } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sharedTail = "ChkAT0wHWFULW0FFclNeUEBKRRAaBVkLXQNGRExxUAhVEE1BFxhZWApa"
const pageUrl = `https://use21.playlist.ttvnw.net/v1/playlist/Dwdf${sharedTail}`
const prefetchUrl = `https://use21.playlist.ttvnw.net/v1/playlist/Cw0VHUcGQAoCCFscFypKDwdf${sharedTail}`

const pageVariants = buildCacheKeyVariants(pageUrl)
const prefetchVariants = buildCacheKeyVariants(prefetchUrl)

assert(pageVariants.length > 0 && prefetchVariants.length > 0, "variants should be built")
assert(pageVariants[0] === prefetchVariants[0], "primary cache key must match across URL rotators")
assert(pageVariants[0].startsWith("aegis|blob|"), "primary should be invariant fingerprint")

const intersection = pageVariants.filter((key) => prefetchVariants.includes(key))
assert(intersection.length > 0, "variant sets must intersect for lookup/store alignment")

console.log("cache-keys-invariant.test.js: all assertions passed")
