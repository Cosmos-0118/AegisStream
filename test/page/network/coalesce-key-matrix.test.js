/**
 * Run: node test/page/network/coalesce-key-matrix.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mediaKeyPath = path.join(__dirname, "../../../src/page/media/media-cache-key-page.js")
const coalescerPath = path.join(
  __dirname,
  "../../../src/page/network/network-fetch-coalescer.js"
)

const sandbox = {
  globalThis: {},
  URL,
  Headers,
  ArrayBuffer,
  location: { href: "https://www.youtube.com/watch?v=test" }
}
sandbox.self = sandbox.globalThis
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(coalescerPath, "utf8"), ctx)

const ns = sandbox.globalThis.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const rangeA = "range|yt|id:abc;itag:248|0-654491"
const rangeB = "range|yt|id:abc;itag:248|0-131072"
assert(
  ns.resolveNetworkCoalesceKey(rangeA, null) === rangeA,
  "canonical range keys must pass through unchanged"
)
assert(rangeA !== rangeB, "different byte ranges must never share a wire key")

ns.buildYoutubeChunkState = (url) => {
  if (typeof url !== "string" || !url.includes("googlevideo.com/videoplayback")) {
    return null
  }
  return {
    type: "bytes",
    start: 0,
    end: 654491,
    cacheKey: rangeA
  }
}
const ytUrl =
  "https://rr1---sn-abc.googlevideo.com/videoplayback?id=abc&itag=248&range=0-654491"
assert(
  ns.resolveNetworkCoalesceKey(ytUrl, null) === rangeA,
  "YouTube playback must resolve to range-scoped keys before structural path"
)

const sharedTail = "ChkAT0wHWFULW0FFclNeUEBKRRAaBVkLXQNGRExxUAhVEE1BFxhZWApa"
const rotatorA = `https://use21.playlist.ttvnw.net/v1/segment/Dwdf${sharedTail}?token=A`
const rotatorB = `https://use21.playlist.ttvnw.net/v1/segment/Cw0V${sharedTail}?token=B`
const blobA = ns.resolveNetworkCoalesceKey(rotatorA, null)
const blobB = ns.resolveNetworkCoalesceKey(rotatorB, null)
assert(blobA && blobA === blobB, "obfuscated blob rotators must share fingerprint invariant")
assert(blobA.startsWith("aegis|blob|"), "blob rotators must not use structural pathname keys")

const samePathAudio = "https://cdn.com/media/seg.ts?track=audio&token=1"
const samePathVideo = "https://cdn.com/media/seg.ts?track=video&token=2"
assert(
  ns.resolveNetworkCoalesceKey(samePathAudio, null) !==
    ns.resolveNetworkCoalesceKey(samePathVideo, null),
  "query track selectors on the same pathname must not collapse"
)

console.log("coalesce-key-matrix.test.js: all assertions passed")
