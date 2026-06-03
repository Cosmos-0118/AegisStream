/**
 * Run: node test/background/media/manifest-mapper.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mapperPath = path.join(__dirname, "../../../src/background/media/manifest-mapper.js")
const sandbox = { self: {}, URL: global.URL, URLSearchParams: global.URLSearchParams }
vm.runInContext(fs.readFileSync(mapperPath, "utf8"), vm.createContext(sandbox))
const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const segments = [
  "https://cdn.example.com/stream/seg-abc?token=111&expires=1",
  "https://cdn.example.com/stream/seg-def?token=222&expires=2",
  "https://cdn.example.com/stream/seg-ghi?token=333&expires=3"
]

const { signatures, signatureToIndex } = api.buildManifestSequenceIndex(segments)
assert(signatures.length === 3, "expected three signatures")
assert(
  signatures[0] === "https://cdn.example.com/stream/seg-abc",
  "signature strips volatile query"
)

const tabState = { segments, manifestSignatures: signatures, signatureToIndex }
const idx = api.resolveSegmentIndexInManifest(
  "https://cdn.example.com/stream/seg-def?token=999&expires=9",
  tabState
)
assert(idx === 1, "chunk resolves by structural pathname, not token digits")

const bogus = api.resolveSegmentIndexInManifest(
  "https://cdn.example.com/stream/seg-zzz?token=1",
  tabState
)
assert(bogus === null, "unknown segment must not guess an index")

const targets = api.getSequentialPrefetchTargets(segments, 0, 2)
assert(targets.length === 2, "prefetch runway follows manifest order")
assert(targets[0] === segments[1], "runway starts at anchor index + 1")
assert(targets[1] === segments[2], "runway continues sequentially in manifest")

const pageA = api.getPageUrlFingerprint("https://example.com/one-piece-episode-1101")
const pageB = api.getPageUrlFingerprint("https://example.com/one-piece-episode-1102")
assert(pageA !== pageB, "episode path change must change page fingerprint")

const watchA = api.getPageUrlFingerprint("https://example.com/watch?id=123")
const watchB = api.getPageUrlFingerprint("https://example.com/watch?id=124")
assert(watchA !== watchB, "watch id change must change page fingerprint")

const tokenOnly = api.getPageUrlFingerprint("https://example.com/watch?v=abc&t=120")
const tokenOnly2 = api.getPageUrlFingerprint("https://example.com/watch?v=abc&t=999")
assert(tokenOnly === tokenOnly2, "seek param must not change page fingerprint")

const reusedPaths = [
  "https://cdn.site.com/segment/000.ts?token=A",
  "https://cdn.site.com/segment/001.ts?token=A"
]
const fp1 = api.buildPlaylistFingerprint({
  segments: reusedPaths,
  mediaPlaylistPath: "https://cdn.site.com/playlist.m3u8",
  mediaSequence: 1,
  totalDuration: 12,
  pageUrl: "https://example.com/ep-1"
})
const fp2 = api.buildPlaylistFingerprint({
  segments: [
    "https://cdn.site.com/segment/000.ts?token=B",
    "https://cdn.site.com/segment/001.ts?token=B"
  ],
  mediaPlaylistPath: "https://cdn.site.com/playlist.m3u8",
  mediaSequence: 1,
  totalDuration: 12,
  pageUrl: "https://example.com/ep-2"
})
const sameStructure = fp1.firstSegmentSignature === fp2.firstSegmentSignature
assert(sameStructure, "fixture: pathname structure unchanged")
const delta = api.scorePlaylistFingerprintChange(fp1, fp2)
assert(delta.contentChanged && delta.pageChanged, "page navigation detects new episode despite reused segment paths")
assert(delta.score >= api.NEW_PLAYBACK_SCORE_THRESHOLD, "page-url alone exceeds threshold")
assert(delta.fingerprintReason === "page-url", "reason lists contributing signals")

const durationOnly = api.scorePlaylistFingerprintChange(fp1, {
  ...fp1,
  totalDuration: 99,
  pageUrlHash: fp1.pageUrlHash
})
assert(!durationOnly.contentChanged, "duration alone stays below threshold")
assert(durationOnly.score === api.PLAYLIST_FINGERPRINT_SCORE.duration, "duration contributes weak score")

const corroborated = api.scorePlaylistFingerprintChange(fp1, {
  ...fp1,
  totalDuration: 99,
  firstSegmentSignature: "https://cdn.site.com/segment/999.ts",
  lastSegmentSignature: "https://cdn.site.com/segment/998.ts",
  mediaPlaylistPath: "https://cdn.site.com/other.m3u8"
})
assert(
  corroborated.contentChanged,
  "multiple medium signals exceed threshold without page change"
)
assert(
  corroborated.fingerprintReason.includes("duration") &&
    corroborated.fingerprintReason.includes("media-playlist"),
  "reason combines multiple signals"
)

const refreshDelta = api.scorePlaylistFingerprintChange(fp1, {
  ...fp1,
  segmentCount: fp1.segmentCount
})
assert(!refreshDelta.contentChanged, "identical fingerprint is not new content")
assert(refreshDelta.fingerprintReason === null, "no reason when score is zero")

const segmentUrlsA = [
  "https://cdn.example.com/vod/seg-00001.ts?sig=A",
  "https://cdn.example.com/vod/seg-00002.ts?sig=A"
]
const segmentUrlsB = [
  "https://cdn.example.com/vod/seg-00001.ts?sig=B",
  "https://cdn.example.com/vod/seg-00002.ts?sig=B"
]
const structuralA = api.buildStructuralPlaylistHash({
  segmentDurations: [4, 4, 4, 4],
  segments: segmentUrlsA,
  discontinuityMarkers: [0, 0, 0, 0],
  isLive: false,
  segmentCount: 4
})
const structuralB = api.buildStructuralPlaylistHash({
  segmentDurations: [4, 4, 4, 4],
  segments: segmentUrlsB,
  discontinuityMarkers: [0, 0, 0, 0],
  isLive: false,
  segmentCount: 4
})
assert(structuralA === structuralB, "same timeline anatomy yields same structural hash")
const structuralQuality = api.buildStructuralPlaylistHash({
  segmentDurations: [2, 2, 2, 2],
  segments: segmentUrlsA,
  discontinuityMarkers: [0, 1, 0, 0],
  isLive: false,
  segmentCount: 4
})
assert(structuralA !== structuralQuality, "duration/discontinuity changes alter structural hash")

const timeIdx = api.estimateManifestIndexFromTime(9, [4, 4, 4, 4, 4], {
  fallbackSegmentDurationSec: 4
})
assert(timeIdx === 2, "manifest index estimated from segment durations")

console.log("manifest-mapper.test.js: ok")
