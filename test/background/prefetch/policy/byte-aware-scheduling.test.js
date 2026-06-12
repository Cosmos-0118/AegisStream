/**
 * Byte-aware scheduling: the batch head (nearest the playhead) keeps strict
 * playback order; the tail is sorted cheapest-first using segment duration
 * as the byte-size proxy.
 *
 * Run: node test/background/prefetch/policy/byte-aware-scheduling.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const policyPath = path.join(
  __dirname,
  "../../../../src/background/prefetch/policy/prefetch-lane-policy.js"
)

const sandbox = {
  self: {
    AegisBackground: {
      state: { inflightPrefetches: new Map() },
      constants: { BYTE_AWARE_HEAD_SEGMENTS: 3 }
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(policyPath, "utf8"), vm.createContext(sandbox))

const { reorderTargetsByByteCost } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const segments = Array.from({ length: 10 }, (_, i) => `https://cdn/seg-${i}.ts`)

// Mixed durations: 4s chunks vs 12s monsters.
const tabState = {
  segments,
  segmentDurations: [4, 4, 4, 12, 4, 12, 4, 12, 4, 4]
}

const targets = segments.slice(0, 9)
const reordered = reorderTargetsByByteCost(targets, tabState)

// Head (first 3) untouched — playhead proximity dominates.
assert(reordered[0] === segments[0], "head[0] keeps playback order")
assert(reordered[1] === segments[1], "head[1] keeps playback order")
assert(reordered[2] === segments[2], "head[2] keeps playback order")

// Tail: cheap 4s chunks before 12s chunks.
const tail = reordered.slice(3)
const tailCosts = tail.map((url) => tabState.segmentDurations[segments.indexOf(url)])
for (let i = 1; i < tailCosts.length; i += 1) {
  assert(tailCosts[i] >= tailCosts[i - 1], `tail sorted ascending, got ${tailCosts.join(",")}`)
}
assert(
  new Set(reordered).size === targets.length,
  "reorder preserves every target exactly once"
)

// Uniform durations: order untouched.
const uniformState = { segments, segmentDurations: new Array(10).fill(6) }
const uniform = reorderTargetsByByteCost(targets, uniformState)
assert(
  uniform.every((url, i) => url === targets[i]),
  "uniform playlist keeps pure playback order"
)

// No duration metadata: order untouched.
const bare = reorderTargetsByByteCost(targets, { segments })
assert(
  bare.every((url, i) => url === targets[i]),
  "missing durations keeps playback order"
)

// Tiny batches are never reordered.
const tiny = reorderTargetsByByteCost(targets.slice(0, 3), tabState)
assert(
  tiny.every((url, i) => url === targets[i]),
  "batch smaller than head+1 untouched"
)

console.log("byte-aware-scheduling.test.js passed")
