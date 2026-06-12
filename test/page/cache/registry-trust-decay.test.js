/**
 * Registry trust decay: "absent" is a confidence verdict, not an oracle.
 * Unknown keys stay lookup-eligible when the registry is stale, never
 * synced, or was recently caught lying (false negative).
 *
 * Run: node test/page/cache/registry-trust-decay.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const registryPath = path.join(__dirname, "../../../src/page/cache/cache-registry.js")

function createRegistrySandbox() {
  const sandbox = {
    location: { href: "https://video.example/watch" },
    URL
  }
  sandbox.globalThis = sandbox
  sandbox.AegisPageBridge = {
    extensionEnabled: true,
    serveFromCache: true,
    stripHash: (url) => String(url || "").split("#")[0],
    resolveNetworkCoalesceKey: (url) => (url ? String(url).toLowerCase().split(/[?#]/)[0] : null),
    isMediaBridgeActive: () => true,
    reportRuntimeMetric: () => {},
    logBridge: () => {}
  }
  vm.runInContext(fs.readFileSync(registryPath, "utf8"), vm.createContext(sandbox))
  return sandbox.AegisPageBridge
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const URL_A = "https://cdn.example/seg-1.ts"
const URL_B = "https://cdn.example/seg-2.ts"

// 1. Never-synced registry: unknown keys must remain lookup candidates.
let bridge = createRegistrySandbox()
assert(
  bridge.resolveCacheConfidence(URL_A) === 0.5,
  "never-synced registry yields neutral confidence"
)
assert(
  bridge.isLikelyCacheHitCandidate(URL_A) === true,
  "unknown key with never-synced registry stays a candidate"
)

// 2. Fresh sync that excludes the key: low confidence, lookup skipped.
bridge.applyCacheRegistrySync({ keys: [bridge.resolveCanonicalCoalesceKey(URL_B)], generation: 1 })
assert(
  bridge.resolveCacheConfidence(URL_A) === 0.2,
  "fresh registry positively claims absence"
)
assert(
  bridge.isLikelyCacheHitCandidate(URL_A) === false,
  "fresh registry absence short-circuits lookup"
)

// 3. Known keys keep high confidence.
assert(bridge.resolveCacheConfidence(URL_B) === 0.9, "cached key confidence 0.9")
assert(bridge.isLikelyCacheHitCandidate(URL_B) === true, "cached key is candidate")

// 4. In-flight intent confidence.
bridge.notePrefetchIntent(URL_A)
assert(bridge.resolveCacheConfidence(URL_A) === 0.8, "inflight key confidence 0.8")
bridge.clearPrefetchIntent(URL_A)

// 5. False negative suspends trust: registry said absent, IDB had bytes.
assert(bridge.isLikelyCacheHitCandidate(URL_A) === false, "back to absent before false negative")
bridge.noteRegistryFalseNegative()
assert(
  bridge.resolveCacheConfidence(URL_A) === 0.5,
  "false negative decays trust to neutral"
)
assert(
  bridge.isLikelyCacheHitCandidate(URL_A) === true,
  "after a false negative every unknown key gets a lookup"
)

console.log("registry-trust-decay.test.js passed")
