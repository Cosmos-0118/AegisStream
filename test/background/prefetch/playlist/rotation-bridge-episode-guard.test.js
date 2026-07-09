/**
 * Regression: rotation alias bridging must never run across content boundaries.
 *
 * Field failure: on an episode switch (new media playlist + page navigation) the
 * rotation bridge positionally aliased the NEW episode's segment URLs onto the
 * OLD episode's cached bytes ("Bridged 88 rotation cache aliases near anchor 48"),
 * so cache lookups served the wrong episode's video — visible corruption.
 *
 * Contract:
 *  1. Same-content token rotation (urls changed, structure/content unchanged)
 *     -> bridgePlaylistSegmentUrlAliases IS called.
 *  2. Episode switch -> bridge is NOT called, and purgeSegmentAliasMappings IS
 *     called with the new segments (heals previously-poisoned alias stores).
 *  3. Quality variant switch -> bridge is NOT called (different rung bytes).
 *
 * Run: node test/background/prefetch/playlist/rotation-bridge-episode-guard.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const modulePath = path.join(
  __dirname,
  "../../../../src/background/prefetch/playlist/playlist-state.js"
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const PlaybackStates = {
  SESSION_ESTABLISHING: "SESSION_ESTABLISHING",
  STABLE_PLAYBACK: "STABLE_PLAYBACK",
  TOKEN_REFRESHING: "TOKEN_REFRESHING",
  QUALITY_SWITCHING: "QUALITY_SWITCHING",
  EPISODE_SWITCHED: "EPISODE_SWITCHED",
  NEW_PLAYBACK: "NEW_PLAYBACK"
}

function signatureOf(url) {
  try {
    const parsed = new URL(url)
    return parsed.pathname
  } catch {
    return String(url).split("?")[0]
  }
}

function makeSandbox(calls) {
  const ns = {
    constants: {
      SEGMENT_URL_HISTORY_DEPTH: 4,
      VARIANT_SWITCH_COOLDOWN_MS: 2000,
      PLAYLIST_ROTATION_GRACE_MS: 5000,
      SEEK_ANCHOR_RETAIN_MS: 30000,
      ANCHOR_SIGNAL_FRESH_MS: 3000,
      VARIANT_SWITCH_GRACE_MS: 8000
    },
    state: {
      playlistByTab: new Map(),
      tabAnchorJumps: new Map(),
      inflightPrefetches: new Map(),
      settings: { prefetchWindow: 8 }
    },
    addLog: () => {},
    PlaybackStates,
    REFRESH_STATE_HEALTHY: "healthy",
    stripHash: (url) => (typeof url === "string" ? url.split("#")[0] : null),
    getManifestUrlSignature: signatureOf,
    buildManifestSequenceIndex: (segments) => {
      const signatureToIndex = new Map()
      const signatures = segments.map((url, i) => {
        const sig = signatureOf(url)
        if (!signatureToIndex.has(sig)) signatureToIndex.set(sig, i)
        return sig
      })
      return { signatures, signatureToIndex }
    },
    buildPlaylistFingerprint: ({ segments, mediaPlaylistPath, pageUrl }) =>
      `fp|${pageUrl || ""}|${mediaPlaylistPath || ""}|${segments.map(signatureOf).join(",")}`,
    buildStructuralPlaylistHash: ({ segments }) => `sh|${segments.length}`,
    buildDurationGeometryHash: (durations, count) =>
      Array.isArray(durations) ? `dg|${durations.join(",")}|${count}` : null,
    // Overridden per scenario:
    scorePlaylistFingerprintChange: () => ({
      contentChanged: false,
      pageChanged: false,
      fingerprintReason: null,
      score: 0,
      threshold: 45
    }),
    determinePlaybackTransition: () => ({
      state: PlaybackStates.TOKEN_REFRESHING,
      clearPrefetch: false,
      retainAnchor: true,
      qualitySwitch: false,
      sessionKey: "session-a",
      sessionChanged: false
    }),
    updateTabSession: () => null,
    clearPrefetchTrackingForUrls: () => {},
    bumpPlaybackGeneration: (tabId, previous) => (Number(previous?.playbackGeneration) || 0) + 1,
    abortManifestRefreshForEpisode: () => {},
    clearTabFailedPrefetches: () => {},
    releaseInflightForTab: () => {},
    syncKnownSegmentsToPage: () => {},
    scheduleVariantSwitchWarmPrefetch: () => {},
    notifyPageSeekingStateReset: () => {},
    bridgePlaylistSegmentUrlAliases: (oldSegs, newSegs, options) => {
      calls.bridge.push({ oldSegs, newSegs, options })
      return Promise.resolve(newSegs.length)
    },
    purgeSegmentAliasMappings: (segments) => {
      calls.purge.push(segments)
      return Promise.resolve(segments.length)
    }
  }
  const sandbox = { self: { AegisBackground: ns } }
  sandbox.globalThis = sandbox
  return sandbox
}

function segments(prefix, token, count) {
  return Array.from(
    { length: count },
    (_, i) => `https://cdn.example.com/${prefix}/seg-${i}.ts?token=${token}`
  )
}

;(async () => {
  // --- Scenario 1: same-content token rotation bridges aliases ---
  {
    const calls = { bridge: [], purge: [] }
    const sandbox = makeSandbox(calls)
    vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
    const ns = sandbox.self.AegisBackground

    const oldSegs = segments("ep1", "aaa", 20)
    const newSegs = segments("ep1", "bbb", 20)

    ns.upsertPlaylistState(1, oldSegs, {
      mediaPlaylistUrl: "https://cdn.example.com/ep1/media.m3u8",
      pageUrl: "https://site.example/watch/ep1",
      segmentDurations: new Array(20).fill(4)
    })
    ns.upsertPlaylistState(1, newSegs, {
      mediaPlaylistUrl: "https://cdn.example.com/ep1/media.m3u8",
      pageUrl: "https://site.example/watch/ep1",
      segmentDurations: new Array(20).fill(4)
    })
    await Promise.resolve()

    assert(calls.bridge.length === 1, "same-content token rotation must bridge aliases")
    assert(calls.purge.length === 0, "token rotation must not purge aliases")
  }

  // --- Scenario 2: episode switch must NOT bridge, must purge ---
  {
    const calls = { bridge: [], purge: [] }
    const sandbox = makeSandbox(calls)
    vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
    const ns = sandbox.self.AegisBackground

    const oldSegs = segments("ep1", "aaa", 20)
    const newSegs = segments("ep2", "ccc", 22)

    ns.upsertPlaylistState(1, oldSegs, {
      mediaPlaylistUrl: "https://cdn.example.com/ep1/media.m3u8",
      pageUrl: "https://site.example/watch/ep1",
      segmentDurations: new Array(20).fill(4)
    })

    // New page + new content -> episode switch classification.
    ns.scorePlaylistFingerprintChange = () => ({
      contentChanged: true,
      pageChanged: true,
      fingerprintReason: "page navigation",
      score: 100,
      threshold: 45
    })
    ns.determinePlaybackTransition = () => ({
      state: PlaybackStates.EPISODE_SWITCHED,
      clearPrefetch: true,
      retainAnchor: false,
      qualitySwitch: false,
      sessionKey: "session-b",
      sessionChanged: true
    })

    ns.upsertPlaylistState(1, newSegs, {
      mediaPlaylistUrl: "https://cdn.example.com/ep2/media.m3u8",
      pageUrl: "https://site.example/watch/ep2",
      segmentDurations: new Array(22).fill(4)
    })
    await Promise.resolve()

    assert(
      calls.bridge.length === 0,
      "episode switch must never bridge rotation aliases — old bytes would be served for the new episode"
    )
    assert(calls.purge.length === 1, "episode switch must purge stale aliases for the new segments")
    assert(
      calls.purge[0].length === newSegs.length && calls.purge[0][0] === newSegs[0],
      "purge must target the NEW episode's segment URLs"
    )
  }

  // --- Scenario 3: quality variant switch must NOT bridge ---
  {
    const calls = { bridge: [], purge: [] }
    const sandbox = makeSandbox(calls)
    vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
    const ns = sandbox.self.AegisBackground

    const oldSegs = segments("ep1/720p", "aaa", 20)
    const newSegs = segments("ep1/1080p", "aaa", 20)

    ns.upsertPlaylistState(1, oldSegs, {
      mediaPlaylistUrl: "https://cdn.example.com/ep1/720p.m3u8",
      pageUrl: "https://site.example/watch/ep1",
      segmentDurations: new Array(20).fill(4)
    })

    ns.determinePlaybackTransition = () => ({
      state: PlaybackStates.QUALITY_SWITCHING,
      clearPrefetch: true,
      retainAnchor: true,
      qualitySwitch: true,
      sessionKey: "session-a",
      sessionChanged: false
    })

    ns.upsertPlaylistState(1, newSegs, {
      mediaPlaylistUrl: "https://cdn.example.com/ep1/1080p.m3u8",
      pageUrl: "https://site.example/watch/ep1",
      segmentDurations: new Array(20).fill(4)
    })
    await Promise.resolve()

    assert(
      calls.bridge.length === 0,
      "quality variant switch must not bridge aliases — different rung bytes"
    )
  }

  console.log("rotation-bridge-episode-guard.test.js: all assertions passed")
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
