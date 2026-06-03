/**
 * Run: node test/background/prefetch/wire/unified-seek-wire.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const wirePath = path.join(__dirname, "../../../../src/background/prefetch/wire/unified-seek-wire.js")
const sandbox = { self: { AegisBackground: {} } }
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(wirePath, "utf8"), vm.createContext(sandbox))

const { parseUnifiedSeekWire, normalizeUnifiedSeekPayload } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const wire = "581.520|58|4.80|62|60|1|12345678"
const parsed = parseUnifiedSeekWire(wire)
assert(parsed?.timeSec > 581, "time parsed")
assert(parsed.estimatedIndex === 58, "index parsed")
assert(parsed.velocitySegPerSec === 4.8, "velocity parsed")
assert(parsed.isScrubbing === true, "scrub flag")
assert(parsed.isRelease === false, "release flag")

const releaseWire = "696.900|68|||68|3|99999"
const release = parseUnifiedSeekWire(releaseWire)
assert(release.isScrubbing && release.isRelease, "combined flags")

const norm = normalizeUnifiedSeekPayload({ wire: releaseWire })
assert(norm?.scrubTrainEnded === false, "normalize object wire")

console.log("unified-seek-wire.test.js: all passed")
