/**
 * Run: node test/background/media/manifest-fetch-coalescer.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const coalescerPath = path.join(
  __dirname,
  "../../../src/background/media/manifest-fetch-coalescer.js"
)

let fetchCalls = 0
const sandbox = {
  self: {
    AegisBackground: {
      addLog: () => {},
      stripHash: (url) => (typeof url === "string" ? url.split("#")[0] : url)
    },
    fetch: async () => {
      fetchCalls += 1
      await new Promise((r) => setTimeout(r, 30))
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/vnd.apple.mpegurl" },
        text: async () => "#EXTM3U\n#EXTINF:1,\nseg.ts\n"
      }
    }
  }
}
sandbox.globalThis = sandbox
sandbox.fetch = sandbox.self.fetch
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(coalescerPath, "utf8"), vm.createContext(sandbox))

const { coalescedFetchPlaylistText } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

;(async () => {
  fetchCalls = 0
  const p1 = coalescedFetchPlaylistText(1, "https://cdn.example.com/v.m3u8")
  const p2 = coalescedFetchPlaylistText(1, "https://cdn.example.com/v.m3u8")
  const [r1, r2] = await Promise.all([p1, p2])
  assert(fetchCalls === 1, `expected 1 fetch, got ${fetchCalls}`)
  assert(r1.ok && r2.ok, "both results should succeed")
  assert(r1.text === r2.text, "coalesced results should match")
  console.log("manifest-fetch-coalescer.test.js: OK")
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
