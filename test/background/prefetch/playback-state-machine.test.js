/**
 * Run: node test/background/prefetch/playback-state-machine.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const srcPath = path.join(
  __dirname,
  "../../../src/background/prefetch/playback-state-machine.js"
)

const sandbox = { self: {} }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(srcPath, "utf8"), vm.createContext(sandbox))

const { determinePlaybackTransition, PlaybackStates } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const previous = {
  segments: ["a"],
  structuralHash: "abc",
  activeRungLabel: "720p",
  mediaPlaylistPath: "/v1/stream.m3u8"
}

const tokenOnly = determinePlaybackTransition(previous, {
  structuralHash: "abc",
  activeRungLabel: "720p",
  mediaPlaylistPath: "/v1/stream.m3u8",
  episodeChanged: false,
  urlsChanged: true
})
assert(
  tokenOnly.state === PlaybackStates.TOKEN_REFRESHING,
  "stable structural hash is token refresh"
)
assert(tokenOnly.clearPrefetch === false, "token refresh keeps prefetch queue")
assert(tokenOnly.retainAnchor === true, "token refresh retains anchor")

const rungOnlyRefresh = determinePlaybackTransition(previous, {
  structuralHash: "abc",
  activeRungLabel: "1080p",
  mediaPlaylistPath: "/v1/stream.m3u8",
  episodeChanged: false,
  urlsChanged: true
})
assert(
  rungOnlyRefresh.state === PlaybackStates.TOKEN_REFRESHING,
  "rung change with stable structure is token refresh"
)
assert(rungOnlyRefresh.clearPrefetch === false, "stable-structure rung change keeps prefetch queue")

const quality = determinePlaybackTransition(previous, {
  structuralHash: "def",
  activeRungLabel: "1080p",
  mediaPlaylistPath: "/v2/stream.m3u8",
  episodeChanged: false,
  urlsChanged: true
})
assert(
  quality.state === PlaybackStates.QUALITY_SWITCHING,
  "structural change with rung/path change is quality switch"
)
assert(quality.clearPrefetch === true, "structural quality switch clears stale prefetch")

console.log("playback-state-machine.test.js: all passed")
