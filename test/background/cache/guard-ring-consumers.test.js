/**
 * Run: node test/background/cache/guard-ring-consumers.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const sandbox = {
  self: {},
  AegisBackground: {
    constants: {
      CACHE_GUARD_RING_PAST_SEGMENTS: 2,
      CACHE_GUARD_RING_FUTURE_SEGMENTS: 12,
      CACHE_GUARD_RING_SEEK_CHURN_PAST: 5,
      CACHE_GUARD_RING_SEEK_CHURN_FUTURE: 24,
      TIMELINE_HEAT_WEIGHT_HISTORICAL: 4
    },
    state: {
      playlistByTab: new Map([
        [
          1,
          {
            segments: ["https://cdn.example.com/seg-0.ts", "https://cdn.example.com/seg-1.ts"],
            anchorIndex: 0,
            hasAnchor: true
          }
        ]
      ]),
      inflightPrefetches: new Map([
        [
          "https://cdn.example.com/seg-locked.ts",
          { tabId: 1, consumers: 2, startedAt: Date.now() }
        ]
      ])
    },
    stripHash: (url) => (typeof url === "string" ? url.split("#")[0] : null),
    buildCacheKeyVariants: (url) => [url],
    resolveSegmentIndexInManifest: () => null
  },
  URL
}
sandbox.self.AegisBackground = sandbox.AegisBackground

vm.runInContext(
  fs.readFileSync(
    path.join(__dirname, "../../../src/background/cache/guard-ring.js"),
    "utf8"
  ),
  vm.createContext(sandbox)
)

const ns = sandbox.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const consumers = ns.collectConsumerProtectedUrls()
assert(consumers.has("https://cdn.example.com/seg-locked.ts"), "consumer URL should be protected")

const tierA = ns.collectTierAProtectedUrls()
assert(tierA.has("https://cdn.example.com/seg-0.ts"), "playhead ring should remain in tier A")
assert(tierA.has("https://cdn.example.com/seg-locked.ts"), "consumer URL should merge into tier A")

console.log("guard-ring-consumers.test.js: all assertions passed")
