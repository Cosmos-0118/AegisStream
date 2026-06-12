/**
 * Future-based request collapsing (P3): a queued-but-not-started prefetch can
 * be demand-started by an intercepted player request, which then joins the
 * coalesced page wire instead of opening a duplicate network socket.
 *
 * Run: node test/page/prefetch/demand-start-collapse.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const coalescerPath = path.join(
  __dirname,
  "../../../src/page/network/network-fetch-coalescer.js"
)
const prefetchPath = path.join(__dirname, "../../../src/page/prefetch/video.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const metrics = []
const fetchCountByUrl = new Map()

const sandbox = {
  URL,
  AbortController,
  location: { href: "https://video.example/watch" },
  document: {
    visibilityState: "visible",
    documentElement: {},
    querySelectorAll: () => [],
    addEventListener: () => {}
  },
  MutationObserver: class {
    observe() {}
  },
  HTMLMediaElement: class {},
  setTimeout,
  clearTimeout,
  Event: class {}
}
sandbox.globalThis = sandbox
sandbox.self = sandbox
sandbox.window = sandbox

sandbox.AegisPageBridge = {
  extensionEnabled: true,
  prefetchEnabled: true,
  stripHash: (url) => String(url || "").split("#")[0],
  monotonicNow: () => Date.now(),
  notifyRuntime: () => {},
  requestRuntime: async () => ({ ok: true }),
  requestExtensionFetchBuffered: async () => ({ ok: false, error: "not-used" }),
  reportRuntimeMetric: (name, payload) => metrics.push({ name, payload }),
  storeChunkFromPage: async () => ({ ok: true }),
  originalFetch: async (url) => {
    fetchCountByUrl.set(url, (fetchCountByUrl.get(url) || 0) + 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    return {
      ok: true,
      status: 200,
      headers: { get: () => "video/mp2t" },
      arrayBuffer: async () => new ArrayBuffer(100)
    }
  },
  logBridge: () => {}
}

const context = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(coalescerPath, "utf8"), context)
vm.runInContext(fs.readFileSync(prefetchPath, "utf8"), context)

const bridge = sandbox.AegisPageBridge

const urls = Array.from({ length: 5 }, (_, i) => `https://cdn.example/seg-${i}.ts`)

async function main() {
  await bridge.prefetchSegmentsFromPage(urls, {})

  // Workers (concurrency 3) immediately picked up the first three URLs; the
  // last two are queued with no active wire.
  const queuedUrl = urls[4]
  assert(
    !bridge.hasActivePageWire(queuedUrl, queuedUrl),
    "queued URL must not have an active wire yet"
  )

  // Player demands the queued segment: it must start immediately and expose
  // a joinable wire.
  const started = bridge.demandStartQueuedPrefetch(queuedUrl, queuedUrl)
  assert(started === true, "demand-start promotes the queued URL")
  assert(
    bridge.hasActivePageWire(queuedUrl, queuedUrl),
    "demand-started URL has an active page wire"
  )
  assert(
    metrics.some((m) => m.name === "prefetch_demand_promotion"),
    "demand promotion metric emitted"
  )

  // Joining the wire yields the prefetch bytes — one socket, many consumers.
  const joined = await bridge.joinCoalescedNetworkFetch(queuedUrl, queuedUrl, {
    timeoutMs: 3_000
  })
  assert(joined?.ok === true, `join must deliver the prefetch result, got ${JSON.stringify(joined)}`)
  assert(joined.bytes?.byteLength === 100, "joined consumer receives the bytes")
  assert(
    fetchCountByUrl.get(queuedUrl) === 1,
    `demanded segment must be fetched exactly once, got ${fetchCountByUrl.get(queuedUrl)}`
  )

  // Unknown URLs are not demand-startable.
  assert(
    bridge.demandStartQueuedPrefetch("https://cdn.example/unknown.ts", null) === false,
    "unknown URL cannot be demand-started"
  )

  console.log("demand-start-collapse.test.js passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
