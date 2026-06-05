/**
 * Documented anime CDN URL shapes (public API docs) — not a substitute for
 * a live capture session on target embed players.
 *
 * Run: node test/page/network/anime-coalesce-validation.test.js
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
const coalesce = (url) => ns.resolveCanonicalCoalesceKey(url)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// HiAnime / NextCDN: each quality is a unique hash directory in the path (public API docs).
const next360 =
  "https://na-191.files.nextcdn.org/hls/01/b49063a1225cf4350deb46d79b42a7572e323274d1c9d63f3b067cc4df09986a/seg-00001.ts?token=aaa"
const next720 =
  "https://na-191.files.nextcdn.org/hls/01/c32da1b1975a5106dcee7e7182219f9b4dbef836fb782d7939003a8cde8f057f/seg-00001.ts?token=bbb"
const next1080 =
  "https://na-191.files.nextcdn.org/hls/01/b85d4450908232aa32b71bc67c80e8aedcc4f32a282e5df9ad82e4662786e9d8/uwu.m3u8?token=ccc"

const k360 = coalesce(next360)
const k720 = coalesce(next720)
const k1080 = coalesce(next1080)
assert(k360 !== k720, "NextCDN 360p vs 720p hash paths must not collapse")
assert(k720 !== k1080, "NextCDN 720p vs 1080p hash paths must not collapse")
assert(!k360.includes("token="), "volatile token must be stripped from coalesce key")

const next360b = next360.replace("token=aaa", "token=zzz")
assert(coalesce(next360b) === k360, "same segment with rotated token must collapse")

// Path-based ladder (playlist-matrix fixture style).
const low = "https://cdn.example.com/low/seg0.ts?a=1"
const mid = "https://cdn.example.com/mid/seg0.ts?b=1"
assert(coalesce(low) !== coalesce(mid), "low vs mid rung paths must not collapse")

// Query-discriminated edge case (hypothetical packager — selector whitelist required).
const qAudio = "https://cdn.com/media/seg.ts?track=audio&token=1"
const qVideo = "https://cdn.com/media/seg.ts?track=video&token=2"
assert(coalesce(qAudio) !== coalesce(qVideo), "track= query selectors must stay isolated")

// Hypothetical unlisted selector — documents validation gap (not a failure today).
const hypotheticalV1 = "https://cdn.com/media/seg.ts?v=1&token=a"
const hypotheticalV2 = "https://cdn.com/media/seg.ts?v=2&token=b"
if (coalesce(hypotheticalV1) === coalesce(hypotheticalV2)) {
  console.warn(
    "VALIDATION GAP: ?v= discriminator collapsed — capture live URLs and expand STREAM_SELECTOR_PARAMS"
  )
}

console.log("anime-coalesce-validation.test.js: documented fixtures passed")
console.log(
  "NextCDN sample keys:",
  JSON.stringify({ k360: k360.slice(0, 80), k720: k720.slice(0, 80) })
)
