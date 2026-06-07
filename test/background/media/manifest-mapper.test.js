/**
 * Run: node test/background/media/manifest-mapper.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mapperPath = path.join(__dirname, "../../../src/background/media/manifest-mapper.js")
const lookupStats = {
  lookupMappingChecks: 0,
  lookupMappingResolved: 0,
  lookupMappingUnresolved: 0
}
const sandbox = {
  self: {
    AegisBackground: {
      state: {
        stats: { ...lookupStats }
      },
      bumpActivity(metric, amount = 1) {
        if (!Number.isFinite(amount)) return
        if (typeof this.state.stats[metric] !== "number") this.state.stats[metric] = 0
        this.state.stats[metric] += amount
      }
    }
  },
  URL: global.URL,
  URLSearchParams: global.URLSearchParams
}
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

const uniqueQuality = api.analyzeManifestIndexQuality(segments, signatureToIndex)
assert(uniqueQuality.segments === 3, "quality report segment count")
assert(uniqueQuality.uniqueSignatures === 3, "distinct pathnames yield unique signatures")
assert(uniqueQuality.duplicateSignatures === 0, "no duplicate signatures on healthy playlist")
assert(uniqueQuality.ambiguousMappings === 0, "no ambiguous mappings on healthy playlist")
assert(uniqueQuality.mappingCoveragePercent === 100, "full mapping coverage when all unique")

const collapsedPaths = [
  "https://cdn.site.com/chunk?token=A",
  "https://cdn.site.com/chunk?token=B",
  "https://cdn.site.com/chunk?token=C",
  "https://cdn.site.com/video.ts?sig=1",
  "https://cdn.site.com/video.ts?sig=2"
]
const collapsedIndex = api.buildManifestSequenceIndex(collapsedPaths)
const collapsedQuality = api.analyzeManifestIndexQuality(collapsedPaths, collapsedIndex.signatureToIndex)
assert(collapsedQuality.segments === 5, "collapsed fixture segment count")
assert(collapsedQuality.uniqueSignatures === 2, "two distinct pathnames")
assert(collapsedQuality.duplicateSignatures === 3, "three segments collapse into duplicates")
assert(collapsedQuality.ambiguousMappings === 2, "both signatures poisoned to -1")
assert(collapsedQuality.resolvableSegments === 0, "no resolvable segments after ambiguity")
assert(collapsedQuality.mappingCoveragePercent === 0, "zero coverage when all signatures ambiguous")
assert(
  collapsedQuality.firstDuplicateExamples[0]?.count === 3,
  "top duplicate example should be /chunk with count 3"
)

const mismatchSegments = [
  "https://manifest.example.com/seg-001.ts",
  "https://manifest.example.com/seg-002.ts"
]
const mismatchQuality = api.analyzeManifestIndexQuality(mismatchSegments)
assert(mismatchQuality.mappingCoveragePercent === 100, "unique manifest paths stay fully mappable")

const lookupTabState = { segments, manifestSignatures: signatures, signatureToIndex }
const mappedLookupIndex = api.resolveSegmentIndexInManifest(
  "https://cdn.example.com/stream/seg-ghi?token=override",
  lookupTabState
)
api.recordLookupMappingCoverage(
  99,
  "https://cdn.example.com/stream/seg-ghi?token=override",
  mappedLookupIndex,
  { source: "unit-test" }
)
api.recordLookupMappingCoverage(
  99,
  "https://cdn.example.com/stream/segment-does-not-exist?token=override",
  null,
  { source: "unit-test" }
)
const lookupSummary = api.getLookupMappingCoverageSummary()
assert(lookupSummary.checks === 2, "lookup mapping checks should aggregate")
assert(lookupSummary.resolved === 1, "lookup mapping resolved count should aggregate")
assert(lookupSummary.unresolved === 1, "lookup mapping unresolved count should aggregate")
assert(lookupSummary.coveragePercent === 50, "lookup mapping coverage should be 50%")
assert(lookupSummary.latestReport?.tabId === 99, "latest lookup mapping report should keep tab id")
assert(
  Array.isArray(lookupSummary.latestReport?.unresolvedExamples) &&
    lookupSummary.latestReport.unresolvedExamples.length === 1,
  "unresolved lookup examples should be recorded"
)

const geometryA = api.buildDurationGeometryHash([4.01, 4.02, 3.98, 4], 4)
const geometryB = api.buildDurationGeometryHash([4.01, 4.02, 3.98, 4], 4)
assert(geometryA === geometryB, "identical duration geometry hashes match")
const geometryC = api.buildDurationGeometryHash([2, 2, 2, 2], 4)
assert(geometryA !== geometryC, "different duration geometry hashes differ")

console.log("manifest-mapper.test.js: ok")
