/**
 * Regression: registry sync is additive by default (P1 hardening).
 *
 * Background:
 *   The XHR `network-native` leak fixed in P0 was made possible because
 *   `applyCacheRegistrySync` historically defaulted to a destructive replace
 *   on every routine sync. A lagging or trimmed routine sync could silently
 *   evict the very key the player was about to ask for, flipping
 *   `isLikelyCacheHitCandidate` to false and routing the XHR to native CDN
 *   fetch — even though the bytes were still on disk.
 *
 *   Defense-in-depth: routine syncs must be additive. Only an authoritative
 *   reason (db-rebuild, tab-sync, manual-purge, authoritative-rebuild,
 *   navigation-reset) may issue a destructive replace. Any other reason +
 *   replace=true is coerced to additive on the page side.
 *
 * Run: node test/page/cache/cache-registry-additive-sync.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const mediaKeyPath = path.join(__dirname, "../../../src/page/media/media-cache-key-page.js")
const coalescerPath = path.join(
  __dirname,
  "../../../src/page/network/network-fetch-coalescer.js"
)
const registryPath = path.join(__dirname, "../../../src/page/cache/cache-registry.js")

const sandbox = {
  globalThis: {},
  URL,
  Headers,
  ArrayBuffer,
  location: { href: "https://www.example.com/" }
}
sandbox.self = sandbox.globalThis
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(mediaKeyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(coalescerPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(registryPath, "utf8"), ctx)

const ns = sandbox.globalThis.AegisPageBridge

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const keyA = "cdn.example.com/live/720p/seg-001.ts"
const keyB = "cdn.example.com/live/720p/seg-002.ts"
const keyC = "cdn.example.com/live/720p/seg-003.ts"
const urlA = `https://${keyA}?token=aaa`
const urlB = `https://${keyB}?token=bbb`
const urlC = `https://${keyC}?token=ccc`

// ---- 1. Seed registry with A and B via authoritative sync (db-rebuild). ----
ns.applyCacheRegistrySync({
  keys: [keyA, keyB],
  replace: true,
  reason: "db-rebuild",
  generation: 1
})
assert(ns.isLikelyCacheHitCandidate(urlA) === true, "A should be a candidate after db-rebuild")
assert(ns.isLikelyCacheHitCandidate(urlB) === true, "B should be a candidate after db-rebuild")
assert(ns.isLikelyCacheHitCandidate(urlC) === false, "C should NOT be a candidate yet")

// ---- 2. Routine sync arriving with only C (lagging view) must NOT evict A/B. ----
// This is the exact scenario the registry-race theory worried about.
ns.applyCacheRegistrySync({
  keys: [keyC],
  replace: false,
  reason: "routine-sync",
  generation: 2
})
assert(
  ns.isLikelyCacheHitCandidate(urlA) === true,
  "routine-sync must NOT evict A (additive merge)"
)
assert(
  ns.isLikelyCacheHitCandidate(urlB) === true,
  "routine-sync must NOT evict B (additive merge)"
)
assert(
  ns.isLikelyCacheHitCandidate(urlC) === true,
  "routine-sync should add C"
)

// ---- 3. Defensive coercion: routine-sync + replace=true must be coerced. ----
// If background code regresses and starts sending replace=true with a non-
// authoritative reason, the page must protect itself.
ns.applyCacheRegistrySync({
  keys: [keyA], // only A — a destructive replace would evict B and C
  replace: true,
  reason: "routine-sync",
  generation: 3
})
assert(
  ns.isLikelyCacheHitCandidate(urlB) === true,
  "coerced replace must NOT evict B"
)
assert(
  ns.isLikelyCacheHitCandidate(urlC) === true,
  "coerced replace must NOT evict C"
)

// ---- 4. Explicit removedKeys delta must work on additive syncs. ----
ns.applyCacheRegistrySync({
  keys: [],
  removedKeys: [keyA],
  replace: false,
  reason: "routine-sync",
  generation: 4
})
assert(
  ns.isLikelyCacheHitCandidate(urlA) === false,
  "explicit removedKeys delta must evict A"
)
assert(
  ns.isLikelyCacheHitCandidate(urlB) === true,
  "removedKeys delta must NOT touch B"
)

// ---- 5. Authoritative replace (db-rebuild) MUST clobber, by design. ----
ns.applyCacheRegistrySync({
  keys: [keyA], // authoritative says only A exists
  replace: true,
  reason: "db-rebuild",
  generation: 5
})
assert(
  ns.isLikelyCacheHitCandidate(urlA) === true,
  "db-rebuild must keep A"
)
assert(
  ns.isLikelyCacheHitCandidate(urlB) === false,
  "db-rebuild must evict B (authoritative)"
)
assert(
  ns.isLikelyCacheHitCandidate(urlC) === false,
  "db-rebuild must evict C (authoritative)"
)

// ---- 6. Other authoritative reasons must also clobber. ----
for (const reason of [
  "tab-sync",
  "manual-purge",
  "authoritative-rebuild",
  "navigation-reset"
]) {
  ns.applyCacheRegistrySync({
    keys: [keyB],
    replace: true,
    reason,
    generation: 100
  })
  assert(
    ns.isLikelyCacheHitCandidate(urlA) === false,
    `${reason} must clobber prior keys`
  )
  assert(
    ns.isLikelyCacheHitCandidate(urlB) === true,
    `${reason} must install new keys`
  )
}

console.log("cache-registry-additive-sync.test.js: all assertions passed")
