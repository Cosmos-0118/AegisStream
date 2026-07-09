/**
 * Run: node test/page/media/obfuscated-playlist-classify.test.js
 *
 * Regression: flixcloud-style JWT playlist URLs look like obfuscated blob
 * segments. Treating them as chunks forces extension-fetch and breaks playback.
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const mediaKeyPath = path.join(__dirname, "../../../src/page/media/media-cache-key-page.js")
const hlsMediaPath = path.join(__dirname, "../../../src/page/media/hls-media.js")

const sandbox = {
  globalThis: {},
  URL,
  location: { href: "https://flixcloud.cc/e/abc" }
}
sandbox.self = sandbox.globalThis
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(hlsMediaPath, "utf8"), ctx)

const ns = sandbox.globalThis.AegisPageBridge

// Flixcloud-style obfuscated media path (no .m3u8 / .ts extension). These
// produce aegis|blob| invariants and used to be treated as chunks, which forced
// playlists through extension-fetch and broke the player.
const obfuscatedPlaylist =
  "https://cdn.example.com/media/BY+/Tdb18UJ2MHyFmBaeNB+aZR9PYhi2UXx+I4oJhb41mrhd5o6TPWwIafqgbZ59Gpd6BHsWONNDQVhm"

const invariant = ns.buildMediaInvariantKey(obfuscatedPlaylist)
assert(
  invariant && invariant.startsWith("aegis|blob|"),
  `expected blob invariant for obfuscated playlist, got ${invariant}`
)
assert(
  ns.isLikelyChunk(obfuscatedPlaylist) === false,
  "obfuscated playlist must NOT be treated as a media chunk"
)

const mp4Segment = "https://cdn.example.com/media/video.mp4"
assert(ns.isLikelyChunk(mp4Segment) === true, "explicit .mp4 remains a chunk")

ns.knownSegments = new Set(["https://cdn.example.com/media/video.mp4"])
assert(
  ns.isLikelyChunk("https://cdn.example.com/media/video.mp4") === true,
  "known base media URL is a chunk"
)
assert(
  ns.isLikelyChunk("https://cdn.example.com/media/video.mp4#aegis-bytes=0-1000") === true,
  "byterange ref of known media URL is a chunk"
)
assert(
  ns.isLikelyChunk(obfuscatedPlaylist) === false,
  "unknown obfuscated playlist still not a chunk after known-segment seed"
)

console.log("obfuscated-playlist-classify.test.js: all assertions passed")
