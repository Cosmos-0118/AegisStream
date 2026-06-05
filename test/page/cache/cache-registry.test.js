/**
 * Run: node test/page/cache/cache-registry.test.js
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
const registryPath = path.join(__dirname, "../../../src/page/cache/cache-registry.js")

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
vm.runInContext(fs.readFileSync(registryPath, "utf8"), ctx)

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
assert(ns.isKeyInFlight(intentUrl) === true, "isKeyInFlight should alias in-flight intent registry")
assert(ns.isInflightKey(intentUrl) === true, "isInflightKey should match isKeyInFlight")
ns.clearPrefetchIntent(intentUrl)
assert(ns.isLikelyCacheHitCandidate(intentUrl) === false, "cleared intent should disable candidate again")

ns.notePrefetchIntent(intentUrl)
ns.noteLocalCacheKey(intentUrl)
assert(
  ns.isLikelyCacheHitCandidate(intentUrl) === true,
  "stored key should remain a hit candidate after intent clears"
)

const hlsSegment = "https://cdn.example.com/live/720p/segment_0045.ts"
const prefetchWithToken = `${hlsSegment}?token=abc&expires=111`
const playerWithToken = `${hlsSegment}?token=xyz&expires=222`
const structural720 = "cdn.example.com/live/720p/segment_0045.ts"
ns.clearPrefetchIntent(intentUrl)
assert(
  ns.resolveCanonicalCoalesceKey(prefetchWithToken) === structural720,
  "HLS coalesce key should be hostname + full pathname"
)
ns.notePrefetchIntent(prefetchWithToken)
assert(
  ns.isKeyInFlight(playerWithToken) === true,
  "HLS CDN token rotation must share one coalesce key for intent lookup"
)

const seg1080 = "https://cdn.com/stream/1080p/seg-12.ts?auth=1"
const seg720 = "https://cdn.com/stream/720p/seg-12.ts?auth=2"
const audioM4s = "https://cdn.com/stream/audio/chunk-1.m4s?s=a"
const videoM4s = "https://cdn.com/stream/video/chunk-1.m4s?s=v"
const k1080 = ns.resolveCanonicalCoalesceKey(seg1080)
const k720 = ns.resolveCanonicalCoalesceKey(seg720)
const kAudio = ns.resolveCanonicalCoalesceKey(audioM4s)
const kVideo = ns.resolveCanonicalCoalesceKey(videoM4s)
assert(k1080 === "cdn.com/stream/1080p/seg-12.ts", "1080p path must stay isolated")
assert(k720 === "cdn.com/stream/720p/seg-12.ts", "720p path must stay isolated")
assert(k1080 !== k720, "1080p and 720p must never share a coalesce key")
assert(kAudio === "cdn.com/stream/audio/chunk-1.m4s", "audio track path must stay isolated")
assert(kVideo === "cdn.com/stream/video/chunk-1.m4s", "video track path must stay isolated")
assert(kAudio !== kVideo, "audio and video renditions must never collapse together")

const shard1 = "https://cdn1.site.com/track/seg-5.ts?token=x"
const shard2 = "https://cdn2.site.com/track/seg-5.ts?token=y"
assert(
  ns.resolveCanonicalCoalesceKey(shard1) !== ns.resolveCanonicalCoalesceKey(shard2),
  "different CDN shards must not share coalesce keys"
)

const queryAudio = "https://cdn.com/media/seg.ts?track=audio&token=1"
const queryVideo = "https://cdn.com/media/seg.ts?track=video&token=2"
const kQueryAudio = ns.resolveCanonicalCoalesceKey(queryAudio)
const kQueryVideo = ns.resolveCanonicalCoalesceKey(queryVideo)
assert(kQueryAudio === "cdn.com/media/seg.ts?track=audio", "query track=audio must stay isolated")
assert(kQueryVideo === "cdn.com/media/seg.ts?track=video", "query track=video must stay isolated")
assert(kQueryAudio !== kQueryVideo, "same pathname with different track selectors must not collapse")

const dash1080 = "https://cdn.com/chunk.m4s?quality=1080&exp=abc"
const dash720 = "https://cdn.com/chunk.m4s?quality=720&exp=xyz"
assert(
  ns.resolveCanonicalCoalesceKey(dash1080) === "cdn.com/chunk.m4s?quality=1080",
  "quality=1080 selector must be preserved"
)
assert(
  ns.resolveCanonicalCoalesceKey(dash720) === "cdn.com/chunk.m4s?quality=720",
  "quality=720 selector must be preserved"
)
assert(
  ns.resolveCanonicalCoalesceKey(dash1080) !== ns.resolveCanonicalCoalesceKey(dash720),
  "DASH quality variants must not share a coalesce key"
)

const tokenRotateA = "https://vcdn.animecdn.com/hls/1080p/seg-12.ts?token=abc123&expires=1"
const tokenRotateB = "https://vcdn.animecdn.com/hls/1080p/seg-12.ts?token=xyz789&expires=2"
const coalesceA = ns.resolveCanonicalCoalesceKey(tokenRotateA)
const coalesceB = ns.resolveCanonicalCoalesceKey(tokenRotateB)
assert(coalesceA === coalesceB, "rotating CDN tokens must share one coalesce key")
assert(
  !coalesceA.includes("token=") && !coalesceA.includes("expires="),
  "coalesce keys must never retain volatile query tokens"
)
const storageA = ns.resolveRegistryKey(tokenRotateA)
const storageB = ns.resolveRegistryKey(tokenRotateB)
assert(storageA === storageB, "storage registry keys must also ignore rotating tokens via invariants")
assert(
  storageA !== coalesceA,
  "coalesce and storage registry namespaces remain decoupled identity formats"
)
ns.notePrefetchIntent(tokenRotateA)
assert(
  ns.isKeyInFlight(tokenRotateB) === true,
  "fresh signature on same segment must match in-flight coalesce intent"
)

const rangeKey = "range|yt|id:abc;itag:248|0-654491"
ns.buildYoutubeChunkState = () => ({
  type: "bytes",
  start: 0,
  end: 654491,
  cacheKey: rangeKey
})
const rawPlaybackUrl =
  "https://rr1---sn-abc.googlevideo.com/videoplayback?id=abc&itag=248&range=0-654491&sig=zzz"
ns.clearPrefetchIntent(prefetchWithToken)
ns.notePrefetchIntent(rawPlaybackUrl)
assert(
  ns.isKeyInFlight(rangeKey) === true,
  "raw YouTube prefetch URL must match canonical range cache lookup key"
)
assert(
  ns.resolveCanonicalCoalesceKey(rawPlaybackUrl) === rangeKey,
  "resolveCanonicalCoalesceKey should align prefetch and XHR namespaces"
)

console.log("cache-registry.test.js: all assertions passed")
