/**
 * Regression: background registry sync payload (P1 hardening).
 *
 * Routine syncs must ship with `replace: false` so a lagging page-side view
 * cannot evict keys the player is about to ask for. Only authoritative reasons
 * (db-rebuild, tab-sync, manual-purge, authoritative-rebuild, navigation-reset)
 * are allowed to issue a destructive replace.
 *
 * Run: node test/background/cache/registry-sync-payload.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const registryPath = path.join(__dirname, "../../../src/background/cache/cache-registry.js")

function makeSandbox() {
  const pendingTimers = []
  const sandbox = {
    self: {
      AegisBackground: {
        constants: { CACHE_REGISTRY_MAX_KEYS: 800, CACHE_REGISTRY_SYNC_DEBOUNCE_MS: 150 },
        state: {
          cacheRegistryKeys: new Set(["aegis|seg-1", "aegis|seg-2"]),
          cacheRegistryGeneration: 7
        },
        addLog: () => {},
        buildCacheKeyVariants: (url) => [url],
        isUmpCacheKey: () => false,
        getUmpBodyHashFromCacheKey: () => null,
        buildMediaInvariantKey: (url) => `aegis|${String(url).split("/").pop()}`,
        isTabMediaContext: () => true
      }
    },
    chrome: {
      tabs: {
        query: async () => [],
        sendMessage: async () => undefined
      }
    },
    setTimeout: (fn) => {
      pendingTimers.push(fn)
      return pendingTimers.length
    },
    clearTimeout: (id) => {
      const idx = (id || 0) - 1
      if (idx >= 0 && idx < pendingTimers.length) pendingTimers[idx] = null
    }
  }
  sandbox.globalThis = sandbox
  sandbox.__drainTimers = async () => {
    while (pendingTimers.some((fn) => typeof fn === "function")) {
      const fn = pendingTimers.shift()
      if (typeof fn === "function") {
        await fn()
        // Drain any microtasks the timer kicked off.
        await Promise.resolve()
        await Promise.resolve()
      }
    }
  }
  return sandbox
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const sandbox = makeSandbox()
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(registryPath, "utf8"), ctx)
const ns = sandbox.self.AegisBackground

// The internal `buildRegistryPayload` is captured by `flushCacheRegistrySync`.
// Intercept via the chrome.tabs.sendMessage path instead.
const sentPayloads = []
sandbox.chrome.tabs.query = async () => [{ id: 1 }]
sandbox.chrome.tabs.sendMessage = async (_tabId, msg) => {
  if (msg?.type === "AegisStream:CacheRegistrySync") {
    sentPayloads.push(msg.payload)
  }
}

;(async () => {
  // 1. syncCacheRegistryToTab (tab-sync) — authoritative.
  await ns.syncCacheRegistryToTab(1)
  const tabSync = sentPayloads.shift()
  assert(tabSync, "tab-sync must emit a payload")
  assert(tabSync.replace === true, "tab-sync is authoritative — must use replace=true")
  assert(tabSync.reason === "tab-sync", "tab-sync reason preserved")

  // 2. registerCacheKeys -> schedule -> flush (routine-sync, additive).
  sandbox.chrome.tabs.query = async () => [{ id: 1 }]
  ns.registerCacheKeys(["https://cdn.example.com/seg-3.ts"])
  await sandbox.__drainTimers()
  const routine = sentPayloads.shift()
  assert(routine, "routine-sync must emit a payload")
  assert(
    routine.replace === false,
    `routine-sync must be additive (replace=false); got replace=${routine.replace}`
  )
  assert(routine.reason === "routine-sync", "routine reason preserved")
  assert(
    routine.keys.includes("aegis|seg-3.ts"),
    "routine payload must include the newly-registered key"
  )

  // 3. unregisterCacheKeys also goes via the routine-sync path (additive on the wire).
  sentPayloads.length = 0
  ns.unregisterCacheKeys(["https://cdn.example.com/seg-3.ts"])
  await sandbox.__drainTimers()
  const afterUnregister = sentPayloads.shift()
  assert(afterUnregister, "unregister must emit a payload")
  assert(
    afterUnregister.replace === false,
    "unregister sync stays additive — destructive removals travel via removedKeys delta or authoritative rebuild"
  )

  // 4. clearCacheRegistry is an authoritative purge — the page must drop its
  //    local view immediately rather than waiting for a later db-rebuild.
  sentPayloads.length = 0
  ns.state.cacheRegistryKeys.add("aegis|seg-9")
  await ns.clearCacheRegistry()
  const clearSync = sentPayloads.shift()
  assert(clearSync, "clear triggers a sync")
  assert(clearSync.replace === true, "clear uses authoritative replace")
  assert(clearSync.reason === "manual-purge", "clear reason is manual-purge")
  assert(Array.isArray(clearSync.keys) && clearSync.keys.length === 0, "clear payload is empty")

  console.log("registry-sync-payload.test.js: all assertions passed")
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
