/**
 * Run: node test/background/media/playlist-byterange.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sandbox = { self: {}, URL, URLSearchParams }
sandbox.globalThis = sandbox
const ctx = vm.createContext(sandbox)

const root = path.join(__dirname, "../../..")
vm.runInContext(fs.readFileSync(path.join(root, "src/background/config/constants.js"), "utf8"), ctx)
vm.runInContext(fs.readFileSync(path.join(root, "src/shared/media-cache-key.js"), "utf8"), ctx)
vm.runInContext(fs.readFileSync(path.join(root, "src/background/media/cache-keys.js"), "utf8"), ctx)
vm.runInContext(fs.readFileSync(path.join(root, "src/background/media/playlist-parser.js"), "utf8"), ctx)
vm.runInContext(fs.readFileSync(path.join(root, "src/background/media/manifest-mapper.js"), "utf8"), ctx)

const ns = sandbox.self.AegisBackground

const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.006,
#EXT-X-BYTERANGE:654492@0
https://cdn.example.com/media/video.mp4
#EXTINF:6.006,
#EXT-X-BYTERANGE:712344@654492
https://cdn.example.com/media/video.mp4
#EXTINF:6.006,
#EXT-X-BYTERANGE:698112@1366836
https://cdn.example.com/media/video.mp4
#EXT-X-ENDLIST
`

const parsed = ns.parseHlsPlaylist(playlist, "https://cdn.example.com/media/index.m3u8")
assert(parsed.kind === "media", "media playlist")
assert(parsed.segments.length === 3, `expected 3 segments, got ${parsed.segments.length}`)

const normalized = ns.normalizeSegments(parsed.segments)
assert(normalized.length === 3, `normalize must keep byterange slices, got ${normalized.length}`)
assert(
  normalized[0].includes("#aegis-bytes=0-654491"),
  `first slice ref wrong: ${normalized[0]}`
)
assert(
  normalized[1].includes("#aegis-bytes=654492-1366835"),
  `second slice ref wrong: ${normalized[1]}`
)

const key0 = ns.resolveByteRangeCacheKey(normalized[0])
const key1 = ns.resolveByteRangeCacheKey(normalized[1])
assert(key0 && key0.startsWith("range|"), `range key0 missing: ${key0}`)
assert(key1 && key1.startsWith("range|"), `range key1 missing: ${key1}`)
assert(key0 !== key1, "distinct byterange slices must have distinct cache keys")

const sig0 = ns.getManifestUrlSignature(normalized[0])
const sig1 = ns.getManifestUrlSignature(normalized[1])
assert(sig0 !== sig1, "manifest signatures must include byte offsets")

const { signatures, signatureToIndex } = ns.buildManifestSequenceIndex(normalized)
assert(signatures.length === 3, "sequence index length")
assert(signatureToIndex.get(sig0) === 0, "first signature maps to index 0")
assert(signatureToIndex.get(sig1) === 1, "second signature maps to index 1")

const playerKey = ns.resolveByteRangeCacheKey(
  "https://cdn.example.com/media/video.mp4",
  "bytes=0-654491"
)
assert(playerKey === key0, "player Range header must resolve to same cache key as playlist ref")

// Relative BYTERANGE offsets (omit @N) must accumulate.
const relativePlaylist = `#EXTM3U
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000
https://cdn.example.com/a.mp4
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000
https://cdn.example.com/a.mp4
#EXT-X-ENDLIST
`
const relative = ns.parseHlsPlaylist(relativePlaylist, "https://cdn.example.com/index.m3u8")
assert(relative.segments[0].endsWith("#aegis-bytes=0-999"), relative.segments[0])
assert(relative.segments[1].endsWith("#aegis-bytes=1000-1999"), relative.segments[1])

// Spaced BYTERANGE values (common in packagers) must parse.
const spacedPlaylist = `#EXTM3U
#EXTINF:6.0,
#EXT-X-BYTERANGE: 654492 @ 0
https://cdn.example.com/media/video.mp4
#EXTINF:6.0,
#EXT-X-BYTERANGE: 712344 @ 654492
https://cdn.example.com/media/video.mp4
#EXT-X-ENDLIST
`
const spaced = ns.parseHlsPlaylist(spacedPlaylist, "https://cdn.example.com/media/index.m3u8")
const spacedNorm = ns.normalizeSegments(spaced.segments)
assert(spacedNorm.length === 2, `spaced byterange must keep 2 slices, got ${spacedNorm.length}`)
assert(spacedNorm[0].includes("#aegis-bytes=0-654491"), spacedNorm[0])
assert(spacedNorm[1].includes("#aegis-bytes=654492-1366835"), spacedNorm[1])

// Non-spec URI-then-BYTERANGE order must still produce distinct slices.
const afterUriPlaylist = `#EXTM3U
#EXTINF:6.0,
https://cdn.example.com/media/video.mp4
#EXT-X-BYTERANGE:1000@0
#EXTINF:6.0,
https://cdn.example.com/media/video.mp4
#EXT-X-BYTERANGE:1000@1000
#EXTINF:6.0,
https://cdn.example.com/media/video.mp4
#EXT-X-BYTERANGE:1000@2000
#EXT-X-ENDLIST
`
const afterUri = ns.parseHlsPlaylist(afterUriPlaylist, "https://cdn.example.com/media/index.m3u8")
const afterNorm = ns.normalizeSegments(afterUri.segments)
assert(afterNorm.length === 3, `uri-then-byterange must keep 3 slices, got ${afterNorm.length}`)
assert(afterNorm[0].includes("#aegis-bytes=0-999"), afterNorm[0])
assert(afterNorm[1].includes("#aegis-bytes=1000-1999"), afterNorm[1])
assert(afterNorm[2].includes("#aegis-bytes=2000-2999"), afterNorm[2])

// Omitted media URI after first segment (flixcloud / fMP4 VOD style).
const omittedUriPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4",BYTERANGE="1000@0"
#EXTINF:6.006,
#EXT-X-BYTERANGE:654492@1000
https://cdn.example.com/media/video.mp4
#EXTINF:6.006,
#EXT-X-BYTERANGE:712344@655492
#EXTINF:6.006,
#EXT-X-BYTERANGE:698112@1367836
#EXT-X-ENDLIST
`
const omitted = ns.parseHlsPlaylist(omittedUriPlaylist, "https://cdn.example.com/media/index.m3u8")
const omittedNorm = ns.normalizeSegments(omitted.segments)
assert(omittedNorm.length === 3, `omitted-URI byterange must expand to 3 slices, got ${omittedNorm.length}`)
assert(omittedNorm[0].includes("#aegis-bytes=1000-655491"), omittedNorm[0])
assert(omittedNorm[1].includes("#aegis-bytes=655492-1367835"), omittedNorm[1])
assert(omittedNorm[2].includes("#aegis-bytes=1367836-2065947"), omittedNorm[2])
assert(
  omittedNorm.every((ref) => ref.includes("video.mp4#aegis-bytes=")),
  "omitted URIs must reuse the last media URI"
)
const omittedKeys = omittedNorm.map((ref) => ns.resolveByteRangeCacheKey(ref))
assert(new Set(omittedKeys).size === 3, "omitted-URI slices need distinct range cache keys")

console.log("playlist-byterange.test.js: all assertions passed")
