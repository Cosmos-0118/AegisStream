/**
 * Regression: the player frame id must survive a playlist rebuild, and a frame
 * must not be able to claim ownership just by answering our own broadcast.
 *
 * Field failure (10.7-minute session, 06:31–06:42): of 43 prefetch delegations
 * made after the player frame was first identified, only 20 were targeted. The
 * rest broadcast to every frame in the tab, and every frame fetched every URL.
 * Targeted and broadcast alternated in runs, which is the shape of an id being
 * learned and wiped repeatedly rather than never learned at all.
 *
 * Two independent causes:
 *
 *  1. playlist-state.js rebuilds tabState as a fresh object literal on every
 *     parse and did not carry playerFrameId/Url/Authoritative forward. A routine
 *     token refresh — which ran constantly in that session — reset the tab to
 *     "player frame unknown". Frame ownership is a property of the tab's DOM,
 *     not of the manifest just parsed.
 *
 *  2. The id was only ever relearned from a StoreChunk, and StoreChunks are
 *     mostly source=prefetch — segments a frame fetched because we asked it to.
 *     While the frame is unknown we ask every frame, so every frame answers, and
 *     last-writer-wins let any frame take the id. The signal was an echo of our
 *     own broadcast (125 of 136 StoreChunks in that session).
 *
 * Contract:
 *  1. An echo claims only an unclaimed tab, and never displaces an observation.
 *  2. Observed player traffic outranks an echo already in place.
 *  3. Authoritative (delivered playlist content) outranks everything, and is the
 *     only tier trusted for a Referer.
 *  4. Authoritative evidence arriving before the tab state exists is kept, not
 *     dropped — that is the fresh-tab case, when it matters most.
 *  5. A playlist rebuild preserves frame identity.
 *  6. Clearing a frame clears its rank, so the tab can learn a new one.
 *
 * Run: node test/background/media/player-frame-identity.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const R = path.join(__dirname, "../../..")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness() {
  const sandbox = {
    console, Date, Math, Number, String, Object, Map, Set, Array, JSON, Promise,
    setTimeout, clearTimeout, URL, TextEncoder, TextDecoder
  }
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  sandbox.chrome = { runtime: { id: "test" } }
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/config/constants.js"), "utf8"), ctx)
  const ns = sandbox.self.AegisBackground
  ns.state = ns.state || {}
  ns.state.playlistByTab = new Map()
  ns.state.tabPageUrlFingerprintByTab = new Map()
  ns.state.tabPageHostByTab = new Map()
  ns.addLog = () => {}
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/media/site-policy.js"), "utf8"), ctx)
  return ns
}

const PLAYER = "https://megaplay.buzz/stream/s-2/220204/dub"
const OTHER = "https://megaplay.buzz/ads/slot"

// ── 1. An echo cannot displace an observation ───────────────────────────────
{
  const ns = makeHarness()
  ns.state.playlistByTab.set(1, { segments: [] })

  ns.notePlayerFrame(1, 435, PLAYER, { evidence: "observed" })
  assert(ns.state.playlistByTab.get(1).playerFrameId === 435, "observed evidence must set the frame")

  ns.notePlayerFrame(1, 12, OTHER, { evidence: "echo" })
  assert(
    ns.state.playlistByTab.get(1).playerFrameId === 435,
    "a frame answering our own broadcast MUST NOT take ownership from an observed frame"
  )
  console.log("  echo cannot displace an observation: OK")

  // ── ...but it may claim an unclaimed tab, so the id can still bootstrap ────
  const ns2 = makeHarness()
  ns2.state.playlistByTab.set(1, { segments: [] })
  ns2.notePlayerFrame(1, 12, PLAYER, { evidence: "echo" })
  assert(
    ns2.state.playlistByTab.get(1).playerFrameId === 12,
    "an echo must still claim a tab with no frame at all, or targeting could never bootstrap"
  )
  console.log("  echo claims an unclaimed tab: OK")
}

// ── 2 & 3. Tier ordering ────────────────────────────────────────────────────
{
  const ns = makeHarness()
  ns.state.playlistByTab.set(1, { segments: [] })

  ns.notePlayerFrame(1, 12, PLAYER, { evidence: "echo" })
  ns.notePlayerFrame(1, 435, PLAYER, { evidence: "observed" })
  assert(
    ns.state.playlistByTab.get(1).playerFrameId === 435,
    "observed player traffic must outrank an echo already in place"
  )
  assert(
    ns.state.playlistByTab.get(1).playerFrameAuthoritative !== true,
    "observed evidence must NOT confer referer trust"
  )

  ns.notePlayerFrame(1, 77, PLAYER, { authoritative: true })
  const st = ns.state.playlistByTab.get(1)
  assert(st.playerFrameId === 77, "authoritative evidence must outrank observed")
  assert(st.playerFrameAuthoritative === true, "authoritative evidence confers referer trust")

  ns.notePlayerFrame(1, 99, PLAYER, { evidence: "observed" })
  assert(
    ns.state.playlistByTab.get(1).playerFrameId === 77,
    "observed evidence must not displace an authoritative frame"
  )
  console.log("  echo < observed < authoritative: OK")
}

// ── 4. Authoritative evidence before the tab state exists ───────────────────
{
  const ns = makeHarness()
  assert(!ns.state.playlistByTab.has(1), "precondition: no tab state yet")

  // This is the real ordering: the PlaylistContent handler calls notePlayerFrame
  // before parsePlaylistContentForTab has built the state.
  ns.notePlayerFrame(1, 435, PLAYER, { authoritative: true })
  const st = ns.state.playlistByTab.get(1)
  assert(st, "notePlayerFrame MUST NOT drop the signal just because state is not built yet")
  assert(st.playerFrameId === 435, "the frame must be recorded on the fresh tab")
  assert(st.playerFrameAuthoritative === true, "authority must survive the fresh-tab path")
  console.log("  authoritative evidence on a fresh tab is kept: OK")
}

// ── 5. A playlist rebuild preserves frame identity ──────────────────────────
{
  const src = fs.readFileSync(
    path.join(R, "src/background/prefetch/playlist/playlist-state.js"),
    "utf8"
  )
  for (const field of [
    "playerFrameId: previous?.playerFrameId",
    "playerFrameUrl: previous?.playerFrameUrl",
    "playerFrameAuthoritative: previous?.playerFrameAuthoritative",
    "playerFrameRank: Number(previous?.playerFrameRank"
  ]) {
    assert(
      src.includes(field),
      `playlist-state.js must carry ${field.split(":")[0]} across a rebuild — a token refresh must not reset the tab to "player frame unknown"`
    )
  }
  console.log("  playlist rebuild carries frame identity forward: OK")
}

// ── 6. Clearing a frame clears its rank ─────────────────────────────────────
{
  for (const rel of [
    "src/background/prefetch/scheduler/page-delegate.js",
    "src/background/prefetch/playlist/manifest-refresh.js",
    "src/background/lifecycle/chrome-events.js"
  ]) {
    const src = fs.readFileSync(path.join(R, rel), "utf8")
    const clears = (src.match(/playerFrameId = null/g) || []).length
    const ranks = (src.match(/playerFrameRank = 0/g) || []).length
    assert(
      ranks >= clears,
      `${rel}: clears playerFrameId ${clears}x but resets playerFrameRank ${ranks}x — a stale rank outranks every future claim, so the tab could never learn a new frame`
    )
  }

  // And prove it behaviourally.
  const ns = makeHarness()
  ns.state.playlistByTab.set(1, { segments: [] })
  ns.notePlayerFrame(1, 435, PLAYER, { authoritative: true })
  const st = ns.state.playlistByTab.get(1)
  st.playerFrameId = null
  st.playerFrameRank = 0
  st.playerFrameAuthoritative = false
  ns.notePlayerFrame(1, 512, PLAYER, { evidence: "observed" })
  assert(
    ns.state.playlistByTab.get(1).playerFrameId === 512,
    "after a clear, a lower tier must be able to claim the tab again"
  )
  console.log("  clearing a frame clears its rank: OK")
}

console.log("player-frame-identity.test.js: OK")
