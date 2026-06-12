/**
 * Regression: idle browse tabs must not steal prefetch focus or receive registry sync.
 *
 * Run: node test/background/prefetch/policy/idle-tab-policy.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const sitePolicyPath = path.join(__dirname, "../../../../src/background/media/site-policy.js")
const tabPolicyPath = path.join(__dirname, "../../../../src/background/prefetch/policy/tab-policy.js")
const registryPath = path.join(__dirname, "../../../../src/background/cache/cache-registry.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sandbox = {
  URL,
  self: {
    AegisBackground: {
      constants: {
        CACHE_REGISTRY_MAX_KEYS: 800,
        CACHE_REGISTRY_SYNC_DEBOUNCE_MS: 150,
        PREFETCH_ANCHOR_COOLDOWN_MS: 5000,
        VARIANT_SWITCH_PREFETCH_WINDOW: 12
      },
      state: {
        settings: { enabled: true, prefetchEnabled: true, prefetchWindow: 8 },
        playlistByTab: new Map([
          [
            7,
            {
              segments: ["https://cdn.example.com/a.ts"],
              updatedAt: Date.now(),
              hasAnchor: true,
              anchorIndex: 3
            }
          ]
        ]),
        pendingPrefetchByTab: new Map(),
        inflightPrefetches: new Map(),
        tabAnchorJumps: new Map(),
        activePrefetchTabId: 7,
        bridgeHeartbeatByTab: new Map(),
        tabPageHostByTab: new Map([[7, "twitch.tv"]]),
        tabPageUrlFingerprintByTab: new Map(),
        cacheRegistryKeys: new Set(["aegis|seg-1"]),
        cacheRegistryGeneration: 1
      },
      addLog: () => {},
      buildCacheKeyVariants: (url) => [url],
      isUmpCacheKey: () => false,
      getUmpBodyHashFromCacheKey: () => null,
      buildMediaInvariantKey: (url) => `aegis|${String(url).split("/").pop()}`,
      getPageUrlFingerprint: () => "fp",
      isTabVisibilitySleeping: () => false,
      recordDecision: () => {},
      broadcastDelegatedPrefetchAbort: () => {},
      tryReleaseInflightEntry: () => {},
      maybeRequestPrefetchForTab: () => {}
    }
  },
  chrome: {
    tabs: {
      query: async () => [],
      sendMessage: async () => undefined
    }
  },
  setTimeout: (fn) => {
    fn()
    return 1
  },
  clearTimeout: () => {}
}
sandbox.globalThis = sandbox

const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(sitePolicyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(tabPolicyPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(registryPath, "utf8"), ctx)

const ns = sandbox.self.AegisBackground

assert(ns.isTabMediaContext(7, "https://www.twitch.tv/channel") === true, "twitch tab is media")
assert(
  ns.isTabMediaContext(9, "https://search.brave.com/") === false,
  "new tab search page is not media"
)
assert(ns.resolvePrefetchFocusTabId(9, "https://search.brave.com/") === 7, "focus stays on media tab")
assert(ns.resolvePrefetchFocusTabId(7, "https://www.twitch.tv/channel") === 7, "twitch tab keeps focus")

let cancelSent = false
sandbox.chrome.tabs.sendMessage = async (_tabId, msg) => {
  if (msg?.type === "AegisStream:CancelPrefetch") cancelSent = true
}

ns.handleTabNavigation(7, "https://search.brave.com/", "navigation")
assert(!ns.state.playlistByTab.has(7), "playlist cleared after leaving twitch")
assert(cancelSent, "cancel prefetch sent to page")

const sent = []
sandbox.chrome.tabs.sendMessage = async (tabId, msg) => {
  if (msg?.type === "AegisStream:CacheRegistrySync") sent.push(tabId)
}

;(async () => {
  await ns.syncCacheRegistryToTab(9)
  assert(sent.length === 0, "idle tab must not receive registry sync")
  await ns.syncCacheRegistryToTab(7)
  assert(sent.length === 1 && sent[0] === 7, "media tab still receives registry sync")
  console.log("idle-tab-policy.test.js: all assertions passed")
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
