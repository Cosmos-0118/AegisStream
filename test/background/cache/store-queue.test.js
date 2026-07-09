/**
 * Run: node test/background/cache/store-queue.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const storeQueuePath = path.join(__dirname, "../../../src/background/cache/store-queue.js")

const sandbox = {
  self: {},
  Promise,
  setTimeout,
  clearTimeout,
  queueMicrotask
}
sandbox.self.AegisBackground = {
  constants: { STORE_WRITE_CONCURRENCY: 2, STORE_WRITE_MAX_QUEUE_DEPTH: 8 },
  stripHash: (url) => String(url || "").split("#")[0]
}
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(storeQueuePath, "utf8"), ctx)

const ns = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run() {
  assert(typeof ns.enqueueStoreWrite === "function", "enqueueStoreWrite should exist")

  let maxActive = 0
  let active = 0

  const tasks = []
  for (let i = 0; i < 6; i += 1) {
    const id = i
    tasks.push(
      ns.enqueueStoreWrite(async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 30))
        active -= 1
        return id
      }, { key: `url-${id % 3}` })
    )
  }

  const results = await Promise.all(tasks)
  assert(results.length === 6, "all tasks should complete")
  assert(maxActive <= 2, `concurrency should be capped at 2 (got ${maxActive})`)

  // Per-key ordering: same key must not overlap / must preserve enqueue order.
  const keyOrder = []
  await Promise.all([
    ns.enqueueStoreWrite(async () => {
      keyOrder.push("a1")
      await new Promise((resolve) => setTimeout(resolve, 40))
      keyOrder.push("a1-done")
    }, { key: "same" }),
    ns.enqueueStoreWrite(async () => {
      keyOrder.push("a2")
      keyOrder.push("a2-done")
    }, { key: "same" })
  ])
  assert(
    keyOrder.join(",") === "a1,a1-done,a2,a2-done",
    `same-key writes must serialize (got ${keyOrder.join(",")})`
  )

  // Rejection isolation: a failed write must not poison later writes for the key.
  const afterFail = await Promise.all([
    ns.enqueueStoreWrite(async () => {
      throw new Error("boom")
    }, { key: "fail-key" }),
    ns.enqueueStoreWrite(async () => ({ ok: true, value: "recovered" }), { key: "fail-key" })
  ])
  assert(afterFail[0]?.ok === false, "failed write should resolve as ok:false")
  assert(afterFail[1]?.ok === true && afterFail[1].value === "recovered", "later write must proceed")

  // Hash-normalized keys share a chain.
  const hashOrder = []
  await Promise.all([
    ns.enqueueStoreWrite(async () => {
      hashOrder.push(1)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }, { key: "https://cdn/x.ts#a" }),
    ns.enqueueStoreWrite(async () => {
      hashOrder.push(2)
    }, { key: "https://cdn/x.ts#b" })
  ])
  assert(hashOrder.join(",") === "1,2", "hash variants must share per-key chain")

  // Backpressure: fill beyond max queue depth.
  const flood = []
  for (let i = 0; i < 20; i += 1) {
    flood.push(
      ns.enqueueStoreWrite(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return i
      }, { key: `flood-${i}` })
    )
  }
  const floodResults = await Promise.all(flood)
  const dropped = floodResults.filter((r) => r?.error === "store-queue-backpressure")
  assert(dropped.length > 0, "backpressure should drop excess tasks")

  const stats = ns.getStoreQueueStats()
  assert(stats.droppedTasks > 0, "stats should track dropped tasks")
  assert(stats.concurrency === 2, "stats concurrency should match config")

  console.log("store-queue.test.js: ok")
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
