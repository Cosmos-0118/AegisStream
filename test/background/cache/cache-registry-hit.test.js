/**
 * Covers the registry read path used by the prefetch scheduler to skip
 * segments already held. Before this existed the scheduler filtered only on
 * in-flight/cooldown/lane, so every reschedule re-delegated cached segments:
 * the page refetched them over the network and the write was rejected
 * downstream as a duplicate, burning bandwidth against the playing stream.
 *
 * A false negative here only costs a redundant fetch; a false positive skips
 * a segment we do not hold, so unregistration must be exact.
 *
 * Run: node test/background/cache/cache-registry-hit.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const registryPath = path.join(__dirname, "../../../src/background/cache/cache-registry.js")
const sharedKeyPath = path.join(__dirname, "../../../src/shared/media-cache-key.js")
const cacheKeysPath = path.join(__dirname, "../../../src/background/media/cache-keys.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness() {
  const sandbox = {
    self: {
      AegisBackground: {
        addLog: () => {},
        state: { cacheRegistryKeys: null },
        // Mirrors the real shape: variants[0] is the primary key.
        buildCacheKeyVariants: (url) => [url],
        buildMediaInvariantKey: (url) =>
          typeof url === "string" && url.includes("/seg") ? `aegis|blob|${url.split("/").pop()}` : null
      }
    },
    setTimeout,
    clearTimeout,
    chrome: { tabs: { query: async () => [], sendMessage: async () => {} } }
  }
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(constantsPath, "utf8"), ctx)
  vm.runInContext(fs.readFileSync(registryPath, "utf8"), ctx)
  return sandbox.self.AegisBackground
}

const A = "https://cdn.example.com/v/seg001.ts"
const B = "https://cdn.example.com/v/seg002.ts"

// ── Empty registry never claims a hit ────────────────────────────────────────
{
  const ns = makeHarness()
  assert(ns.isCacheRegistryHit(A) === false, "empty registry must not report a hit")
  assert(ns.isCacheRegistryHit("") === false, "empty url must not report a hit")
  assert(ns.isCacheRegistryHit(null) === false, "null url must not report a hit")
  console.log("  empty registry: OK")
}

// ── Registered keys are found; unrelated ones are not ────────────────────────
{
  const ns = makeHarness()
  ns.registerCacheKeys([A])
  assert(ns.isCacheRegistryHit(A) === true, "registered url must report a hit")
  assert(ns.isCacheRegistryHit(B) === false, "unregistered url must not report a hit")
  console.log("  register/lookup: OK")
}

// ── Unregistering must clear the hit (the TTL-sweep contract) ────────────────
{
  const ns = makeHarness()
  ns.registerCacheKeys([A, B])
  assert(ns.isCacheRegistryHit(A) && ns.isCacheRegistryHit(B), "both should register")

  ns.unregisterCacheKeys([A])
  assert(
    ns.isCacheRegistryHit(A) === false,
    "unregistered url must stop reporting a hit — otherwise the scheduler " +
      "permanently skips refetching a swept segment"
  )
  assert(ns.isCacheRegistryHit(B) === true, "unrelated key must survive unregistration")
  console.log("  unregister: OK")
}

// ── Clearing drops everything ────────────────────────────────────────────────
{
  const ns = makeHarness()
  ns.registerCacheKeys([A, B])
  void ns.clearCacheRegistry()
  assert(ns.isCacheRegistryHit(A) === false, "clear must drop all keys")
  assert(ns.isCacheRegistryHit(B) === false, "clear must drop all keys")
  console.log("  clear: OK")
}

// ── A URL with no derivable invariant key is a miss, not a throw ─────────────
{
  const ns = makeHarness()
  ns.registerCacheKeys([A])
  assert(
    ns.isCacheRegistryHit("https://cdn.example.com/other/thing.bin") === false,
    "unmappable url must be a miss"
  )
  console.log("  unmappable url: OK")
}

// ── The real key projection, not a stub ──────────────────────────────────────
// The stubbed harness above cannot catch a projection that silently drops
// URLs. This one loads the production media-cache-key + cache-keys modules so
// the registry is exercised through the same code path the service worker uses.
function makeRealHarness() {
  const sandbox = {
    self: { AegisBackground: { addLog: () => {}, state: { cacheRegistryKeys: null } } },
    setTimeout,
    clearTimeout,
    URL,
    chrome: { tabs: { query: async () => [], sendMessage: async () => {} } }
  }
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  for (const file of [constantsPath, sharedKeyPath, cacheKeysPath, registryPath]) {
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx)
  }
  return sandbox.self.AegisBackground
}

{
  const ns = makeRealHarness()
  // Ordinary HLS: projects to an aegis| invariant key.
  const ts = "https://cdn.example.com/abc123/1080p/0042.ts"
  ns.registerCacheKeys(ns.buildCacheKeyVariants(ts))
  assert(ns.isCacheRegistryHit(ts) === true, "a .ts segment must register and hit")

  // Decoy extension: .jpg is not in HLS_EXT, so buildMediaInvariantKey returns
  // null. Dropping that null left the registry empty for entire streams —
  // isCacheRegistryHit could never fire, and the scheduler re-fetched every
  // segment it already held until the store path rejected the bytes.
  const jpg = "https://s3.shiora.site/ag64242554d79f74a2c2d8be7629c1e88b4h/1080p/0042.jpg"
  assert(
    ns.buildMediaInvariantKey(jpg) === null,
    "precondition: this URL has no invariant key — the fallback is what must save it"
  )
  ns.registerCacheKeys(ns.buildCacheKeyVariants(jpg))
  assert(
    ns.isCacheRegistryHit(jpg) === true,
    "a decoy-extension segment must register and hit via the raw-URL fallback"
  )

  // The fallback must not blur distinct segments together.
  const other = "https://s3.shiora.site/ag64242554d79f74a2c2d8be7629c1e88b4h/1080p/0043.jpg"
  assert(ns.isCacheRegistryHit(other) === false, "a sibling segment must not hit")

  // And unregistration must still be exact through the fallback path.
  ns.unregisterCacheKeys(ns.buildCacheKeyVariants(jpg))
  assert(ns.isCacheRegistryHit(jpg) === false, "unregister must clear a fallback-keyed entry")
  assert(ns.isCacheRegistryHit(ts) === true, "unrelated invariant key must survive")
  console.log("  real key projection (decoy extension): OK")
}

console.log("cache-registry-hit.test.js: OK")
