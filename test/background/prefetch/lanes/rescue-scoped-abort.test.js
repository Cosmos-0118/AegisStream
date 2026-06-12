/**
 * Scoped rescue abort: rescue must protect in-flight fetches near the
 * playhead (keep window) and target the reconciled playhead consensus, not
 * a stale committed anchor.
 *
 * Run: node test/background/prefetch/lanes/rescue-scoped-abort.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const rescuePath = path.join(__dirname, "../../../../src/background/prefetch/lanes/rescue-lane.js")
const reconcilerPath = path.join(
  __dirname,
  "../../../../src/background/prefetch/anchor/anchor-reconciler.js"
)

const sandbox = {
  self: {
    AegisBackground: {
      state: { playlistByTab: new Map() },
      constants: {
        RESCUE_SEGMENTS_AHEAD: 2,
        RESCUE_KEEP_BEHIND_SEGMENTS: 2,
        RESCUE_KEEP_AHEAD_SEGMENTS: 8,
        ANCHOR_SIGNAL_FRESH_MS: 3_000,
        ANCHOR_RECONCILE_DIVERGENCE_SEGMENTS: 3,
        ANCHOR_RECONCILE_DWELL_MS: 500,
        ANCHOR_RECONCILE_MIN_INTERVAL_MS: 800
      },
      addLog: () => {}
    }
  }
}
sandbox.globalThis = sandbox
const context = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(reconcilerPath, "utf8"), context)
vm.runInContext(fs.readFileSync(rescuePath, "utf8"), context)

const { resolveRescueKeepWindow, resolveRescuePlayheadIndex, resolveRescuePlayheadTargets } =
  sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const segments = Array.from({ length: 40 }, (_, i) => `https://cdn/seg-${i}.ts`)

// Plain anchor, no fresher signals: keep window centers on the anchor.
const plain = { segments, anchorIndex: 10 }
const plainKeep = resolveRescueKeepWindow(plain)
assert(plainKeep[0] === segments[8], `keep window starts at anchor-2, got ${plainKeep[0]}`)
assert(
  plainKeep[plainKeep.length - 1] === segments[18],
  `keep window ends at anchor+8, got ${plainKeep[plainKeep.length - 1]}`
)
assert(plainKeep.length === 11, `keep window spans behind+ahead+1, got ${plainKeep.length}`)

// Stale anchor=0 while predictor + player evidence agree on 8 (the log's
// failure mode): rescue must keep/target around 8, not 0.
const now = Date.now()
const scrub = {
  segments,
  anchorIndex: 0,
  predictedAnchorIndex: 8,
  predictedAnchorAt: now,
  lastPlayerObservedIndex: 8,
  lastPlayerObservedAt: now
}
assert(
  resolveRescuePlayheadIndex(scrub) === 8,
  `rescue playhead should follow consensus 8, got ${resolveRescuePlayheadIndex(scrub)}`
)
const scrubKeep = resolveRescueKeepWindow(scrub)
assert(scrubKeep.includes(segments[8]), "keep window includes the real playhead")
assert(scrubKeep.includes(segments[9]), "keep window includes playhead+1")
assert(!scrubKeep.includes(segments[20]), "segments far ahead are abortable")

const targets = resolveRescuePlayheadTargets(scrub, segments)
assert(targets[0] === segments[8], `rescue targets start at consensus, got ${targets[0]}`)
assert(targets.length === 2, "rescue targets respect RESCUE_SEGMENTS_AHEAD")

// Window clamps at playlist edges.
const nearEnd = { segments, anchorIndex: 38 }
const endKeep = resolveRescueKeepWindow(nearEnd)
assert(endKeep[endKeep.length - 1] === segments[39], "keep window clamps at playlist end")
const nearStart = { segments, anchorIndex: 0 }
const startKeep = resolveRescueKeepWindow(nearStart)
assert(startKeep[0] === segments[0], "keep window clamps at playlist start")

console.log("rescue-scoped-abort.test.js passed")
