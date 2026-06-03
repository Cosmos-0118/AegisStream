/**
 * Run: node test/background/cache/storage-bypass.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const dbPath = path.join(__dirname, "../../../src/background/cache/db.js")

const logs = []
const sandbox = {
  self: {
    AegisBackground: {
      constants: {},
      state: {
        settings: { serveFromCache: true, maxEntries: 100 },
        cachePolicy: null
      },
      addLog: (_level, msg) => logs.push(msg),
      stripHash: (url) => String(url || "").split("#")[0],
      buildCacheKeyVariants: (url) => [url],
      isUmpCacheKey: () => false,
      getUmpBodyHashFromCacheKey: () => null
    }
  },
  indexedDB: {
    open() {
      const req = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        error: { name: "UnknownError", message: "corrupt database" },
        result: null
      }
      setTimeout(() => {
        if (typeof req.onerror === "function") req.onerror()
      }, 0)
      return req
    }
  }
}
sandbox.setTimeout = (fn) => {
  fn()
  return 0
}
sandbox.clearTimeout = () => {}
sandbox.globalThis = sandbox
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), ctx)
vm.runInContext(fs.readFileSync(dbPath, "utf8"), ctx)

const { safeCacheChunk, isStorageSystemOperational, engageStoragePassthroughValve } =
  sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

;(async () => {
  assert(isStorageSystemOperational() === true, "storage starts operational")
  const blocked = await safeCacheChunk("https://cdn.example.com/a.ts", "video/mp2t", new ArrayBuffer(8))
  assert(blocked.ok === false, "open failure returns not ok")
  assert(blocked.bypass === true, "open failure engages bypass")
  assert(isStorageSystemOperational() === false, "storage bypass latched")
  assert(sandbox.self.AegisBackground.state.settings.serveFromCache === false, "serveFromCache disabled")
  engageStoragePassthroughValve("test", new Error("quota"))
  assert(logs.some((line) => line.includes("pass-through")), "bypass logged once")
  console.log("storage-bypass.test.js: OK")
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
