/**
 * Run: node test/page/media/playlist-capture-body-guard.test.js
 *
 * Regression: some sites (e.g. flixcloud-style embeds) serve an encrypted/obfuscated
 * blob under a .m3u8 URL or application/vnd.apple.mpegurl content-type as an
 * anti-scraping measure. maybeCapturePlaylist() must not relay that ciphertext to the
 * background as "playlist content" just because the URL/content-type matched — the
 * body itself must also look like real HLS/DASH text.
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

const notified = []
const sandbox = {
  globalThis: {},
  URL,
  location: { href: "https://flixcloud.cc/e/abc" }
}
sandbox.self = sandbox.globalThis
sandbox.self.AegisPageBridge = {
  canRelayPlaylist: () => true,
  markPlaylistRelayed: () => {},
  notifyRuntime: (type, payload) => notified.push({ type, payload }),
  logBridge: () => {},
  originalFetch: () => Promise.reject(new Error("unused in this test")),
  requestRuntime: () => Promise.resolve(),
  storeChunkFromPage: () => Promise.resolve({ ok: true }),
  formatStoreChunkError: () => "error"
}
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(hlsMediaPath, "utf8"), ctx)

const ns = sandbox.globalThis.AegisPageBridge

function fakeResponse(text) {
  return { text: () => Promise.resolve(text) }
}

async function run() {
  // Encrypted blob served under a real .m3u8 URL with a matching content-type header —
  // must NOT be relayed, even though both the URL and content-type "match".
  const encryptedBlob = "G2ENsHStaz9HTPao/HYOO8tmyN8AgmWnqwTClDub".repeat(200)
  ns.maybeCapturePlaylist(
    "https://flixcloud.cc/api/m3u8/abc123.m3u8",
    "application/vnd.apple.mpegurl",
    fakeResponse(encryptedBlob)
  )
  await Promise.resolve()
  await Promise.resolve()
  assert(notified.length === 0, `encrypted blob under matching URL must not be relayed, got ${notified.length} notification(s)`)

  // A real playlist body under a non-.m3u8 obfuscated URL (content-type match only) must relay.
  const realPlaylist = "#EXTM3U\n#EXTINF:6.0,\nhttps://cdn.example.com/seg0.mp4\n#EXT-X-ENDLIST\n"
  ns.maybeCapturePlaylist(
    "https://flixcloud.cc/api/m3u8/def456",
    "application/vnd.apple.mpegurl",
    fakeResponse(realPlaylist)
  )
  await Promise.resolve()
  await Promise.resolve()
  assert(notified.length === 1, `real playlist body must be relayed, got ${notified.length} notification(s)`)
  assert(notified[0].type === "PLAYLIST_CONTENT", "relayed message must be PLAYLIST_CONTENT")
  assert(notified[0].payload.text === realPlaylist, "relayed text must match real playlist body")

  console.log("playlist-capture-body-guard.test.js: all assertions passed")
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
