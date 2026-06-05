/**
 * Run: node test/background/cache/eviction-journal.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const root = path.join(__dirname, "../../..")
const load = (rel) => fs.readFileSync(path.join(root, rel), "utf8")

const sandbox = {
  self: {
    state: {
      stats: {},
      playlistByTab: new Map(),
      logs: []
    }
  },
  URL
}
sandbox.globalThis = sandbox

const ctx = vm.createContext(sandbox)
vm.runInContext(load("src/background/config/constants.js"), ctx)
vm.runInContext(load("src/background/state/runtime-state.js"), ctx)
vm.runInContext(load("src/background/telemetry/collectors/activity-metrics.js"), ctx)
vm.runInContext(load("src/background/media/serializers.js"), ctx)
vm.runInContext(load("src/shared/media-cache-key.js"), ctx)
vm.runInContext(load("src/background/media/cache-keys.js"), ctx)
vm.runInContext(load("src/background/media/manifest-mapper.js"), ctx)
vm.runInContext(load("src/background/cache/eviction-journal.js"), ctx)

const ns = sandbox.self.AegisBackground
const {
  recordEvictedChunks,
  noteRecentlyEvictedMiss,
  resolveStoreDedupKey,
  shouldSkipDuplicateStore,
  markStoreDedupKey,
  resetEvictionJournal,
  resolvePlaybackDistanceForUrl
} = ns

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

resetEvictionJournal()
const state = sandbox.self.AegisBackground.state
state.stats = sandbox.self.AegisBackground.constants.createInitialStats()

const tabId = 7
const segments = [
  "https://proxy.example/stream/seg0",
  "https://proxy.example/stream/seg1",
  "https://proxy.example/stream/seg2"
]
state.playlistByTab.set(tabId, {
  segments,
  anchorIndex: 1,
  signatureToIndex: new Map([
    ["https://proxy.example/stream/seg0", 0],
    ["https://proxy.example/stream/seg1", 1],
    ["https://proxy.example/stream/seg2", 2]
  ]),
  manifestSignatures: segments.map((url) => {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  })
})

const evictedUrl = segments[2]
recordEvictedChunks([{ url: evictedUrl, byteLength: 2_200_000 }])

const dist = resolvePlaybackDistanceForUrl(evictedUrl)
assert(dist.manifestMapped === true, "mapped segment should resolve manifest distance")
assert(dist.signedDistance === 1, "segment ahead of anchor should be +1")

const miss = noteRecentlyEvictedMiss(evictedUrl)
assert(miss?.recentlyEvicted === true, "recently evicted miss should be detected")
assert(miss.evictedSecondsAgo >= 0, "evicted age should be non-negative")
assert(miss.signedDistance === 1, "miss should carry signed distance from eviction")
assert(
  state.stats.recentlyEvictedMisses === 1,
  "recentlyEvictedMisses counter should increment"
)

const never = noteRecentlyEvictedMiss("https://proxy.example/stream/never-cached")
assert(never === null, "unknown url should not match eviction journal")
assert(
  state.stats.cacheMissNeverStored === 1,
  "cacheMissNeverStored counter should increment"
)

resetEvictionJournal()
recordEvictedChunks([
  { url: "https://cdn.example/obfuscated/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", byteLength: 512_000 }
])
assert(
  state.stats.evictedWithoutManifestMap === 1,
  "unmapped eviction should increment evictedWithoutManifestMap"
)

const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const storeUrl =
  "https://cdn.example/obfuscated/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const dedupKey = resolveStoreDedupKey(storeUrl, bytes)
assert(typeof dedupKey === "string" && dedupKey.includes("|"), `dedup key should include crc (${dedupKey})`)
assert(!shouldSkipDuplicateStore(dedupKey), "first store attempt should not dedup")
markStoreDedupKey(dedupKey)
assert(shouldSkipDuplicateStore(dedupKey), "second store attempt should dedup")

console.log("eviction-journal.test.js: all assertions passed")
