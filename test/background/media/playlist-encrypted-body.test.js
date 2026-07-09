/**
 * Run: node test/background/media/playlist-encrypted-body.test.js
 *
 * Regression: some sites (e.g. flixcloud-style embeds) serve an encrypted/obfuscated
 * blob under a .m3u8 URL / application/vnd.apple.mpegurl content-type as an
 * anti-scraping measure. Their own page JS decrypts it before handing real text to
 * hls.js. Treating that ciphertext as playlist text turns the whole blob into one
 * bogus "segment" URL (via new URL(garbage, base)), which then 404s forever and
 * drives buffer-rescue into a thrashing loop. The parser must detect and reject it.
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

const ns = sandbox.self.AegisBackground

// Simulates an encrypted single-line blob served with a playlist-looking URL/content-type.
const encryptedBlob =
  "JUTOhU70OoBII4OyhnbNT24w+iMp9aeBv15dXao2fRBSQMSWRpMr3zknj6/kYNooHmiKLz7vsO+YMF1Bt1oIbkNQw5RNhCqwW2z4o/N6zUEGMuUrP/fU5OFQTFyuXh9rSUWc8kafO6czS5Ko72uwXGUm7CQyls7y8jBdS6pILx5DWcKYTYFVu1tI69OZHtApB2jBHhLL".repeat(50)

const parsedEncrypted = ns.parseHlsPlaylist(encryptedBlob, "https://flixcloud.cc/api/m3u8/abc123.m3u8")
assert(parsedEncrypted.kind === "invalid", `expected kind=invalid for encrypted body, got ${parsedEncrypted.kind}`)
assert(parsedEncrypted.segments.length === 0, `expected 0 segments for encrypted body, got ${parsedEncrypted.segments.length}`)
assert(parsedEncrypted.variants.length === 0, "expected 0 variants for encrypted body")

// Sanity: a real playlist (even a tiny one) is unaffected by the new guard.
const realPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
https://cdn.example.com/media/seg0.mp4
#EXT-X-ENDLIST
`
const parsedReal = ns.parseHlsPlaylist(realPlaylist, "https://cdn.example.com/media/index.m3u8")
assert(parsedReal.kind === "media", `expected kind=media for real playlist, got ${parsedReal.kind}`)
assert(parsedReal.segments.length === 1, `expected 1 segment for real playlist, got ${parsedReal.segments.length}`)

// Leading whitespace/BOM before #EXTM3U must still be recognized as real.
const withBom = `\uFEFF#EXTM3U
#EXTINF:6.0,
https://cdn.example.com/media/seg0.mp4
#EXT-X-ENDLIST
`
const parsedBom = ns.parseHlsPlaylist(withBom, "https://cdn.example.com/media/index.m3u8")
assert(parsedBom.kind === "media", `expected BOM-prefixed real playlist to still parse, got ${parsedBom.kind}`)

// Non-string / empty input must not throw and must be treated as invalid.
assert(ns.parseHlsPlaylist("", "https://cdn.example.com/index.m3u8").kind === "invalid", "empty text is invalid")
assert(ns.parseHlsPlaylist(null, "https://cdn.example.com/index.m3u8").kind === "invalid", "null text is invalid")

console.log("playlist-encrypted-body.test.js: all assertions passed")
