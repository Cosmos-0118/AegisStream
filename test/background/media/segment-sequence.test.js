/**
 * Covers pattern-addressed segment ladder detection: sites that expose no
 * .m3u8/.mpd and address segments purely by a counter in the URL (often under
 * a decoy extension). Without this the tab never gets a `segments` array and
 * every prefetch entry point short-circuits on its empty-array guard, leaving
 * the engine dormant for the whole session.
 *
 * Run: node test/background/media/segment-sequence.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const modulePath = path.join(__dirname, "../../../src/background/media/segment-sequence.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness() {
  const logs = []
  const upserts = []
  const sandbox = {
    self: {
      AegisBackground: {
        addLog: (level, message) => logs.push(`${level}:${message}`),
        state: {
          settings: { enabled: true, prefetchEnabled: true },
          playlistByTab: new Map(),
          stats: {}
        },
        bumpActivity: () => {},
        upsertPlaylistState: (tabId, segments, meta) => {
          const existing = sandbox.self.AegisBackground.state.playlistByTab.get(tabId) || {}
          const tabState = { ...existing, segments, meta }
          sandbox.self.AegisBackground.state.playlistByTab.set(tabId, tabState)
          upserts.push({ tabId, segments, meta })
          return tabState
        }
      }
    },
    URL
  }
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(constantsPath, "utf8"), ctx)
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), ctx)
  return { ns: sandbox.self.AegisBackground, logs, upserts }
}

const BIG = 2 * 1024 * 1024
const seg = (n) =>
  `https://s1.akirax.buzz/ag29e17c1d879aa583f8cd980778835cab4h/1080p/${String(n).padStart(4, "0")}.jpg`

// ── URL parsing ──────────────────────────────────────────────────────────────
{
  const { ns } = makeHarness()
  const parsed = ns.parseSequentialSegmentUrl(seg(7))
  assert(parsed, "should parse a decoy-extension segment URL")
  assert(parsed.index === 7, `expected index 7, got ${parsed.index}`)
  assert(parsed.width === 4, `expected width 4, got ${parsed.width}`)
  assert(parsed.suffix === ".jpg", `expected .jpg suffix, got ${parsed.suffix}`)
  assert(parsed.prefix === "", `expected empty prefix, got ${parsed.prefix}`)

  // The digit run must be captured whole, and the *last* run must win.
  const multi = ns.parseSequentialSegmentUrl("https://cdn.example.com/v/chunk12_003.ts")
  assert(multi && multi.index === 3, `expected index 3, got ${multi && multi.index}`)
  assert(multi.prefix === "chunk12_", `expected prefix chunk12_, got ${multi.prefix}`)
  assert(multi.width === 3, `expected width 3, got ${multi.width}`)

  // Single-digit counters are too common in ordinary asset names.
  assert(
    ns.parseSequentialSegmentUrl("https://cdn.example.com/v/5.ts") === null,
    "single-digit counter must not parse"
  )
  assert(ns.parseSequentialSegmentUrl("not a url") === null, "garbage must not parse")
  console.log("  parse: OK")
}

// ── URL synthesis round-trips against the observed shape ─────────────────────
{
  const { ns } = makeHarness()
  const pattern = ns.parseSequentialSegmentUrl(seg(7))
  const urls = ns.buildSequentialSegmentUrls(pattern, 12)
  assert(urls.length === 12, `expected 12 urls, got ${urls.length}`)
  assert(urls[7] === seg(7), `index 7 must round-trip: ${urls[7]}`)
  assert(urls[0] === seg(0), `index 0 must round-trip: ${urls[0]}`)
  console.log("  synthesis: OK")
}

// ── Adoption after a forward-moving run ──────────────────────────────────────
{
  const { ns, upserts, logs } = makeHarness()
  assert(ns.noteSequentialSegmentObservation(1, seg(7), BIG) === false, "1 observation: no adopt")
  assert(ns.noteSequentialSegmentObservation(1, seg(8), BIG) === false, "2 observations: no adopt")
  const adopted = ns.noteSequentialSegmentObservation(1, seg(9), BIG)
  assert(adopted === true, "3rd consecutive observation should adopt the ladder")
  assert(upserts.length === 1, `expected 1 upsert, got ${upserts.length}`)
  assert(upserts[0].segments.length === 2000, `expected 2000 segments, got ${upserts[0].segments.length}`)
  assert(upserts[0].segments[9] === seg(9), "synthesized ladder must align with observed URLs")
  assert(
    logs.some((l) => l.startsWith("INFO:Adopted sequential segment ladder")),
    "adoption should be logged"
  )
  // Adoption is once-per-pattern; later segments must not re-upsert.
  assert(ns.noteSequentialSegmentObservation(1, seg(10), BIG) === false, "must not re-adopt")
  assert(upserts.length === 1, "must not upsert twice for the same ladder")
  console.log("  adoption: OK")
}

// ── A dropped store mid-run is tolerated ─────────────────────────────────────
{
  const { ns } = makeHarness()
  ns.noteSequentialSegmentObservation(1, seg(7), BIG)
  ns.noteSequentialSegmentObservation(1, seg(9), BIG) // 0008 store failed
  assert(
    ns.noteSequentialSegmentObservation(1, seg(10), BIG) === true,
    "a single-segment gap should still adopt"
  )
  console.log("  gap tolerance: OK")
}

// ── False-positive guards ────────────────────────────────────────────────────
{
  // Small payloads are page furniture, not media.
  const { ns, upserts } = makeHarness()
  for (const n of [7, 8, 9, 10]) {
    ns.noteSequentialSegmentObservation(1, seg(n), 40 * 1024)
  }
  assert(upserts.length === 0, "sub-threshold payloads must never adopt")
}
{
  // Same shape but no forward movement — a gallery re-fetching one image.
  const { ns, upserts } = makeHarness()
  for (let i = 0; i < 5; i += 1) ns.noteSequentialSegmentObservation(1, seg(7), BIG)
  assert(upserts.length === 0, "repeated identical index must not adopt")
}
{
  // Scattered indices are not a playback timeline.
  const { ns, upserts } = makeHarness()
  for (const n of [3, 400, 91, 1200]) ns.noteSequentialSegmentObservation(1, seg(n), BIG)
  assert(upserts.length === 0, "non-consecutive indices must not adopt")
}
{
  // A genuinely parsed playlist must never be shadowed.
  const { ns, upserts } = makeHarness()
  ns.state.playlistByTab.set(1, { segments: ["https://real/seg1.ts"] })
  for (const n of [7, 8, 9, 10]) ns.noteSequentialSegmentObservation(1, seg(n), BIG)
  assert(upserts.length === 0, "must not shadow a real playlist")
}
{
  // Per-segment tokens make a ladder unforgeable; each URL is its own pattern.
  const { ns, upserts } = makeHarness()
  for (const n of [7, 8, 9, 10]) {
    ns.noteSequentialSegmentObservation(1, `${seg(n)}?token=tok${n}`, BIG)
  }
  assert(upserts.length === 0, "per-segment query tokens must not adopt")
}
{
  // Prefetch disabled means no adoption work at all.
  const { ns, upserts } = makeHarness()
  ns.state.settings.prefetchEnabled = false
  for (const n of [7, 8, 9, 10]) ns.noteSequentialSegmentObservation(1, seg(n), BIG)
  assert(upserts.length === 0, "disabled prefetch must not adopt")
}
console.log("  false-positive guards: OK")

// ── auth_expired is cleared so the ladder is not inert ───────────────────────
{
  const { ns } = makeHarness()
  let transitioned = null
  ns.REFRESH_STATE_AUTH_EXPIRED = "auth_expired"
  ns.REFRESH_STATE_HEALTHY = "healthy"
  ns.transitionRefreshState = (tabId, tabState, next, reason) => {
    transitioned = { next, reason }
    tabState.refreshState = next
  }
  ns.state.playlistByTab.set(1, { refreshState: "auth_expired" })
  for (const n of [7, 8, 9]) ns.noteSequentialSegmentObservation(1, seg(n), BIG)
  assert(transitioned, "adopting a ladder must clear auth_expired")
  assert(transitioned.next === "healthy", `expected healthy, got ${transitioned.next}`)
  console.log("  auth_expired clear: OK")
}

// ── Per-tab isolation and reset ──────────────────────────────────────────────
{
  const { ns, upserts } = makeHarness()
  ns.noteSequentialSegmentObservation(1, seg(7), BIG)
  ns.noteSequentialSegmentObservation(2, seg(8), BIG)
  assert(upserts.length === 0, "observations must not pool across tabs")

  ns.noteSequentialSegmentObservation(1, seg(8), BIG)
  ns.resetSequentialSegmentTracking(1)
  assert(ns.getSequentialSegmentTracker(1) === null, "reset must drop the tracker")
  assert(ns.noteSequentialSegmentObservation(1, seg(9), BIG) === false, "reset must restart the run")
  console.log("  tab isolation: OK")
}

console.log("segment-sequence.test.js: OK")
