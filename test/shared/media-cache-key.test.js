/**
 * Run: node test/shared/media-cache-key.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../src/background/config/constants.js")
const mediaKeyPath = path.join(__dirname, "../../src/shared/media-cache-key.js")

const sandbox = { self: {}, URL }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), vm.createContext(sandbox))

const { buildMediaInvariantKey, resolvePrefetchCoalesceKey } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sharedTail = "ChkAT0wHWFULW0FFclNeUEBKRRAaBVkLXQNGRExxUAhVEE1BFxhZWApa"
const pagePath = `Dwdf${sharedTail}`
const prefetchPath = `Cw0VHUcGQAoCCFscFypKDwdf${sharedTail}`
const host = "use21.playlist.ttvnw.net"

const pageKey = buildMediaInvariantKey(`https://${host}/v1/segment/${pagePath}`)
const prefetchKey = buildMediaInvariantKey(`https://${host}/v1/segment/${prefetchPath}`)

assert(pageKey && prefetchKey, "invariant keys should be produced for obfuscated blobs")
assert(pageKey === prefetchKey, "page and prefetch URLs must share one invariant cache key")
assert(pageKey.endsWith(sharedTail), "invariant key should end with structural tail")
assert(pageKey.startsWith(`aegis|blob|${host}|`), "invariant key should include host scope")

const hlsKey = buildMediaInvariantKey("https://cdn.example.com/live/720p/segment_0045.ts")
assert(hlsKey === "aegis|hls|cdn.example.com|720p/segment_0045.ts", "standard HLS tail key")

const tokenA = resolvePrefetchCoalesceKey(`https://${host}/v1/segment/${pagePath}?token=A`)
const tokenB = resolvePrefetchCoalesceKey(`https://${host}/v1/segment/${pagePath}?token=B`)
assert(tokenA === tokenB, "signed query rotation must share coalesce key")
assert(tokenA === pageKey, "coalesce key should match invariant cache key")

assert(
  resolvePrefetchCoalesceKey("range|yt|abc|0-1023") === "range|yt|abc|0-1023",
  "canonical range keys pass through"
)

const {
  parseAegisByteRangeRef,
  buildByteRangeCacheKey,
  resolveByteRangeCacheKey
} = sandbox.self.AegisBackground

const rangedRef = "https://cdn.example.com/media/video.mp4#aegis-bytes=0-654491"
const parsedRange = parseAegisByteRangeRef(rangedRef)
assert(parsedRange?.start === 0 && parsedRange?.end === 654491, "parse aegis byterange ref")
const rangeKey = buildByteRangeCacheKey(parsedRange.url, parsedRange.start, parsedRange.end)
assert(rangeKey && rangeKey.startsWith("range|"), "build byterange cache key")
assert(
  resolveByteRangeCacheKey(rangedRef) === rangeKey,
  "ref resolves to byterange cache key"
)
assert(
  resolveByteRangeCacheKey(parsedRange.url, "bytes=0-654491") === rangeKey,
  "Range header resolves to same byterange cache key"
)
assert(
  resolvePrefetchCoalesceKey(rangedRef) === rangeKey,
  "prefetch coalesce uses byterange cache key"
)

console.log("media-cache-key.test.js: all assertions passed")
