/**
 * Regression: the cache must build runway while the network is good.
 *
 * Field failure (10.7-minute session): 89 of 99 prefetch delegations were a
 * single segment. The scheduler's own trace explains it —
 * `{"targets":10,"blockedCached":9,"uncached":1}` — the batcher was correct, the
 * window was ten segments wide. bufferRunwaySec held at 20-30s for the entire
 * session and never grew: prefetch exactly matched playback and built nothing.
 *
 * Cause: every widening rule in resolveEffectivePrefetchWindow is reactive. The
 * window grows only once runway has fallen to the aggressive (15s) or emergency
 * (5s) threshold, so at a healthy runway all boosts are inactive and the cache
 * converges to the base window. Depth is the thing that survives a slowdown, and
 * it can only be built beforehand — by the time the reactive rules fire, the
 * bandwidth needed to act on them is gone. The cache budget was never the limit:
 * hundreds of MB available, ~4MB of lookahead used.
 *
 * Contract — the guards are the whole design, so each is asserted separately:
 *  1. From a standing start with a healthy runway, depth extends the window well
 *     past the urgent one, at low priority.
 *  2. Never while anything is in flight — the urgent lane owns the bandwidth.
 *  3. Never on a low or UNKNOWN runway. Unknown must decline, not guess.
 *  4. Never while playback is unsettled (seek/scrub/churn/variant/teleport):
 *     those fetches would be thrown away.
 *  5. Never more than PREFETCH_DEPTH_CACHE_SHARE of the cache. Eviction is
 *     playback-distance aware, so an unbounded target would evict its own far
 *     end and then the near-playhead segments — worse than not filling.
 *  6. Bounded by the seconds target, the hard segment cap, and what remains of
 *     the manifest.
 *  7. Cooldown holds between passes, and depth never re-enters itself.
 *
 * Run: node test/background/prefetch/lanes/depth-lane.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const R = path.join(__dirname, "../../../..")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness(overrides = {}) {
  const sandbox = {
    console, Date, Math, Number, String, Object, Map, Set, Array, JSON, Promise,
    setTimeout, clearTimeout, URL, TextEncoder, TextDecoder
  }
  sandbox.self = sandbox
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(R, "src/background/config/constants.js"), "utf8"), ctx)
  const ns = sandbox.self.AegisBackground

  const scheduled = []
  ns.state = {
    settings: { enabled: true, prefetchEnabled: true },
    cachePolicy: { maxEntries: 500 },
    playlistByTab: new Map()
  }
  ns.addLog = () => {}
  ns.bumpActivity = () => {}
  ns.isPrefetchBlocked = () => false
  ns.countGlobalInflightPrefetches = () => 0
  ns.schedulePrefetch = (tabId, segments, startIndex, options) => {
    scheduled.push({ tabId, startIndex, options })
  }
  Object.assign(ns, overrides)

  vm.runInContext(
    fs.readFileSync(path.join(R, "src/background/prefetch/lanes/depth-lane.js"), "utf8"),
    ctx
  )
  return { ns, scheduled }
}

const SEGMENTS = Array.from({ length: 400 }, (_, i) => `https://cdn/seg-${i}.ts`)
const HEALTHY = { bufferRunwaySec: 26, segmentDurations: Array(400).fill(4) }

// ── 1. Standing start with a healthy runway ─────────────────────────────────
{
  const { ns, scheduled } = makeHarness()
  const ok = ns.maybeScheduleDepthFill(1, { ...HEALTHY }, SEGMENTS, 100, { urgentWindow: 10 })
  assert(ok === true, "a healthy standing start MUST trigger a depth pass")
  assert(scheduled.length === 1, `expected one schedule, got ${scheduled.length}`)

  const opts = scheduled[0].options
  assert(opts.source === "depth-fill", `expected source depth-fill, got ${opts.source}`)
  assert(opts.priority === "low", "depth must queue behind the player's own fetches")
  assert(opts.force === true, "depth must bypass the urgent lane's duplicate-schedule guard")
  // 180s target / 4s segments = 45, under both the 120 hard cap and the 250 share cap.
  assert(
    opts.prefetchWindowOverride === 45,
    `expected a 45-segment window (180s / 4s), got ${opts.prefetchWindowOverride}`
  )
  assert(
    opts.prefetchWindowOverride > 10 * 4,
    "the whole point is a window several times the urgent one"
  )
  console.log(`  standing start extends 10 -> ${opts.prefetchWindowOverride} segments at low priority: OK`)
}

// ── 2. Never while the urgent lane is working ───────────────────────────────
{
  const { ns, scheduled } = makeHarness({ countGlobalInflightPrefetches: () => 1 })
  assert(
    ns.maybeScheduleDepthFill(1, { ...HEALTHY }, SEGMENTS, 100, { urgentWindow: 10 }) === false,
    "depth MUST NOT start while anything is in flight"
  )
  assert(scheduled.length === 0, "no schedule may be issued when the urgent lane is busy")
  console.log("  declines while segments are in flight: OK")
}

// ── 3. Low runway, and unknown runway ───────────────────────────────────────
{
  const { ns } = makeHarness()
  assert(
    ns.maybeScheduleDepthFill(1, { ...HEALTHY, bufferRunwaySec: 8 }, SEGMENTS, 100, { urgentWindow: 10 }) === false,
    "depth MUST NOT spend bandwidth on the future while the present is thin"
  )
  for (const unknown of [undefined, null, NaN, "n/a"]) {
    assert(
      ns.maybeScheduleDepthFill(1, { ...HEALTHY, bufferRunwaySec: unknown }, SEGMENTS, 100, { urgentWindow: 10 }) === false,
      `an unknown runway (${String(unknown)}) must decline, not guess`
    )
  }
  console.log("  declines on low and unknown runway: OK")
}

// ── 4. Unsettled playback ───────────────────────────────────────────────────
{
  const guards = [
    "isTabInRapidSeek",
    "isTabInScrubbingTrain",
    "isTabInSeekChurnAggressive",
    "isTabInVariantSwitchGrace",
    "isTabInTeleportMode"
  ]
  for (const guard of guards) {
    const { ns, scheduled } = makeHarness({ [guard]: () => true })
    assert(
      ns.maybeScheduleDepthFill(1, { ...HEALTHY }, SEGMENTS, 100, { urgentWindow: 10 }) === false,
      `${guard} must suppress depth fill — those fetches would be discarded`
    )
    assert(scheduled.length === 0, `${guard}: nothing may be scheduled`)
  }
  // And a blocked tab.
  const { ns } = makeHarness({ isPrefetchBlocked: () => true })
  assert(
    ns.maybeScheduleDepthFill(1, { ...HEALTHY }, SEGMENTS, 100, { urgentWindow: 10 }) === false,
    "a blocked tab must not depth fill"
  )
  console.log(`  declines on ${guards.length} unsettled states + blocked tab: OK`)
}

// ── 5. Cache share cap ──────────────────────────────────────────────────────
{
  // A tiny cache: 50 entries * 0.5 share = 25 segments, below the 45 the seconds
  // target would otherwise ask for.
  const { ns, scheduled } = makeHarness()
  ns.state.cachePolicy = { maxEntries: 50 }
  ns.maybeScheduleDepthFill(1, { ...HEALTHY }, SEGMENTS, 100, { urgentWindow: 10 })
  assert(
    scheduled[0].options.prefetchWindowOverride === 25,
    `a 50-entry cache must cap depth at 25 (half), got ${scheduled[0].options.prefetchWindowOverride}`
  )
  console.log("  depth never exceeds its share of the cache: OK")
}

// ── 6. Seconds target, hard cap, end of manifest ────────────────────────────
{
  // Short segments: 180s / 1s = 180, above the 120 hard cap.
  const { ns, scheduled } = makeHarness()
  ns.maybeScheduleDepthFill(1, { bufferRunwaySec: 26, segmentDurations: Array(400).fill(1) }, SEGMENTS, 0, { urgentWindow: 10 })
  assert(
    scheduled[0].options.prefetchWindowOverride === 120,
    `the hard segment cap must bind, got ${scheduled[0].options.prefetchWindowOverride}`
  )

  // Long segments: 180s / 10s = 18.
  const b = makeHarness()
  b.ns.maybeScheduleDepthFill(1, { bufferRunwaySec: 26, segmentDurations: Array(400).fill(10) }, SEGMENTS, 0, { urgentWindow: 10 })
  assert(
    b.scheduled[0].options.prefetchWindowOverride === 18,
    `depth is a duration target, not a segment count, got ${b.scheduled[0].options.prefetchWindowOverride}`
  )

  // Near the end of the manifest there is less left than the target.
  const c = makeHarness()
  c.ns.maybeScheduleDepthFill(1, { ...HEALTHY }, SEGMENTS, 380, { urgentWindow: 5 })
  assert(
    c.scheduled[0].options.prefetchWindowOverride === 20,
    `depth must clamp to what remains, got ${c.scheduled[0].options.prefetchWindowOverride}`
  )

  // Nothing to gain over the urgent window: no pass at all.
  const d = makeHarness()
  assert(
    d.ns.maybeScheduleDepthFill(1, { ...HEALTHY }, SEGMENTS, 398, { urgentWindow: 10 }) === false,
    "a depth window no wider than the urgent one must not schedule"
  )
  console.log("  bounded by seconds target, hard cap, and manifest end: OK")
}

// ── 7. Cooldown and non-reentrancy ──────────────────────────────────────────
{
  const { ns, scheduled } = makeHarness()
  const tabState = { ...HEALTHY }
  assert(ns.maybeScheduleDepthFill(1, tabState, SEGMENTS, 100, { urgentWindow: 10 }) === true, "first pass runs")
  assert(
    ns.maybeScheduleDepthFill(1, tabState, SEGMENTS, 100, { urgentWindow: 10 }) === false,
    "a second pass inside the cooldown must be suppressed"
  )
  assert(scheduled.length === 1, "cooldown must prevent a second schedule")

  tabState.lastDepthFillAt = Date.now() - 10_000
  assert(
    ns.maybeScheduleDepthFill(1, tabState, SEGMENTS, 100, { urgentWindow: 10 }) === true,
    "after the cooldown the lane runs again"
  )

  assert(ns.isDepthFillSource("depth-fill") === true, "depth passes must be identifiable")
  assert(ns.isDepthFillSource("chunk-observed") === false, "urgent sources are not depth")

  // The scheduler must not re-enter the lane from a depth pass.
  const sched = fs.readFileSync(
    path.join(R, "src/background/prefetch/scheduler/prefetch-scheduler.js"),
    "utf8"
  )
  assert(
    /!isDepthFill[\s\S]{0,240}maybeScheduleDepthFill/.test(sched),
    "the scheduler hook must be guarded on !isDepthFill or depth fill recurses into itself"
  )
  assert(
    /blockedInflight === 0 && blockedCooldown === 0 && blockedLane === 0 && blockedCached > 0[\s\S]{0,160}maybeScheduleDepthFill/.test(sched),
    "depth may only trigger when the batch was empty because everything was CACHED — not when the urgent lane is blocked on inflight/cooldown/lane"
  )
  console.log("  cooldown holds, and depth never re-enters itself: OK")
}

// ── 8. Retry continuity ─────────────────────────────────────────────────────
{
  // A depth pass asks for ~45 segments but is capped to PREFETCH_DEPTH_BATCH_
  // INFLIGHT_CAP in flight, so it ALWAYS leaves work behind and ALWAYS takes the
  // cap-retry path. If the retry dropped prefetchWindowOverride it would resume
  // at the urgent window, find the near segments already cached, schedule
  // nothing, and burn the retry budget to "Prefetch cap retry exhausted" —
  // depth would advance only one batch per trigger and then stall.
  const sched = fs.readFileSync(
    path.join(R, "src/background/prefetch/scheduler/prefetch-scheduler.js"),
    "utf8"
  )
  for (const fn of ["schedulePrefetchCapRetry", "schedulePrefetchInflightRetry"]) {
    const body = sched.slice(sched.indexOf(`function ${fn}(`))
    const scoped = body.slice(0, body.indexOf("\n}\n"))
    assert(
      /windowOverride/.test(scoped) && /prefetchWindowOverride: pending\.windowOverride/.test(scoped),
      `${fn} must carry prefetchWindowOverride into the retry, or a depth pass resumes at the urgent window`
    )
  }
  // NaN must not survive into a snapshot: `??` does not treat it as absent.
  assert(
    /windowOverride = Number\.isFinite\(windowOverrideRaw\)[^\n]*: null/.test(sched),
    "an absent override must normalize to null, not NaN"
  )
  console.log("  retries carry the depth window forward: OK")
}

console.log("depth-lane.test.js: OK")
