/**
 * Run: node test/page/media/kalman-segment-filter.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const filterPath = path.join(
  __dirname,
  "../../../src/page/media/kalman-segment-filter.js"
)
const sandbox = { self: { AegisPageBridge: {} } }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(filterPath, "utf8"), vm.createContext(sandbox))

const { KalmanSegmentFilter } = sandbox.self.AegisPageBridge
sandbox.self.AegisPageBridge.SCRUB_KALMAN_MAX_JUMP_SEGMENTS = 8

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const filter = new KalmanSegmentFilter()
let t = 1000
filter.update(28, t)
t += 80
filter.update(27, (t += 80))
t += 80
filter.update(26, (t += 80))
const predicted = filter.predictIndex(0.4, 148, 26)
assert(predicted >= 24 && predicted <= 28, "kalman prediction stays near anchor, got " + predicted)
assert(predicted !== 0, "kalman must not collapse to index 0 during backward scrub")

filter.reset(50)
const forward = filter.predictIndex(0.4, 100, 50)
assert(forward >= 48 && forward <= 58, "forward prediction bounded")

const { resolveDynamicLookaheadSec } = sandbox.self.AegisPageBridge
assert(
  Math.abs(resolveDynamicLookaheadSec(0) - 0.2) < 0.001,
  "low velocity uses 200ms base"
)
assert(
  Math.abs(resolveDynamicLookaheadSec(10) - 0.8) < 0.001,
  "high velocity clamps to 800ms"
)

filter.reset(40)
filter.x[1] = 0.5
const slowPred = filter.predictIndex(null, 100, 40)
filter.x[1] = 8
const fastPred = filter.predictIndex(null, 100, 40)
assert(fastPred > slowPred, "faster scrub casts wider lookahead net")

console.log("kalman-segment-filter.test.js: all passed")
