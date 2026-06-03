/**
 * Run: node test/background/media/manifest-mapper.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mapperPath = path.join(__dirname, "../../../src/background/media/manifest-mapper.js")
const sandbox = { self: {} }
vm.runInContext(fs.readFileSync(mapperPath, "utf8"), vm.createContext(sandbox))
const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const segments = [
  "https://cdn.example.com/stream/seg-abc?token=111&expires=1",
  "https://cdn.example.com/stream/seg-def?token=222&expires=2",
  "https://cdn.example.com/stream/seg-ghi?token=333&expires=3"
]

const { signatures, signatureToIndex } = api.buildManifestSequenceIndex(segments)
assert(signatures.length === 3, "expected three signatures")
assert(
  signatures[0] === "https://cdn.example.com/stream/seg-abc",
  "signature strips volatile query"
)

const tabState = { segments, manifestSignatures: signatures, signatureToIndex }
const idx = api.resolveSegmentIndexInManifest(
  "https://cdn.example.com/stream/seg-def?token=999&expires=9",
  tabState
)
assert(idx === 1, "chunk resolves by structural pathname, not token digits")

const bogus = api.resolveSegmentIndexInManifest(
  "https://cdn.example.com/stream/seg-zzz?token=1",
  tabState
)
assert(bogus === null, "unknown segment must not guess an index")

const targets = api.getSequentialPrefetchTargets(segments, 0, 2)
assert(targets.length === 2, "prefetch runway follows manifest order")
assert(targets[0] === segments[1], "runway starts at anchor index + 1")
assert(targets[1] === segments[2], "runway continues sequentially in manifest")

console.log("manifest-mapper.test.js: ok")
