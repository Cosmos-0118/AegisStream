(() => {
var ns = (self.AegisBackground ||= {})

const DEFAULT_STORE_WRITE_CONCURRENCY = 4
const DEFAULT_MAX_QUEUE_DEPTH = 256
const MAX_PER_KEY_TAILS = 512

/** @type {Map<string, Promise<unknown>>} */
const perKeyTail = new Map()
let active = 0
/** @type {Array<{ run: () => Promise<unknown>, resolve: (v: unknown) => void, reject: (e: unknown) => void }>} */
const waitQueue = []
let rejectedTasks = 0
let completedTasks = 0
let droppedTasks = 0

function resolveConcurrency() {
  const configured = Number(ns.constants?.STORE_WRITE_CONCURRENCY)
  return Math.max(1, Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STORE_WRITE_CONCURRENCY)
}

function resolveMaxQueueDepth() {
  const configured = Number(ns.constants?.STORE_WRITE_MAX_QUEUE_DEPTH)
  return Math.max(
    resolveConcurrency(),
    Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_QUEUE_DEPTH
  )
}

function normalizeStoreKey(key) {
  if (typeof key !== "string" || !key) return null
  const stripped = typeof ns.stripHash === "function" ? ns.stripHash(key) : key.split("#")[0]
  return stripped || null
}

function resolveStoreKey(task) {
  if (typeof task !== "function") return null
  if (typeof task.storeKey === "string" && task.storeKey) return normalizeStoreKey(task.storeKey)
  if (typeof task.url === "string" && task.url) return normalizeStoreKey(task.url)
  return null
}

function pumpWaitQueue() {
  const concurrency = resolveConcurrency()
  while (active < concurrency && waitQueue.length > 0) {
    const next = waitQueue.shift()
    if (!next) break
    active += 1
    let settled = false
    const finish = (ok, value) => {
      if (settled) return
      settled = true
      active = Math.max(0, active - 1)
      try {
        if (ok) {
          completedTasks += 1
          next.resolve(value)
        } else {
          rejectedTasks += 1
          next.reject(value)
        }
      } catch {
        // Caller resolve/reject must never stall the queue.
      }
      // Defer pump so a long synchronous resolve chain cannot starve the event loop.
      queueMicrotask(pumpWaitQueue)
    }

    Promise.resolve()
      .then(next.run)
      .then(
        (value) => finish(true, value),
        (error) => finish(false, error)
      )
  }
}

function enqueueUnbounded(task) {
  if (waitQueue.length + active >= resolveMaxQueueDepth()) {
    droppedTasks += 1
    return Promise.resolve({
      ok: false,
      skipped: true,
      error: "store-queue-backpressure"
    })
  }
  return new Promise((resolve, reject) => {
    waitQueue.push({
      run: () => {
        try {
          return task()
        } catch (error) {
          return Promise.reject(error)
        }
      },
      resolve,
      reject
    })
    pumpWaitQueue()
  })
}

function prunePerKeyTails() {
  if (perKeyTail.size <= MAX_PER_KEY_TAILS) return
  const excess = perKeyTail.size - MAX_PER_KEY_TAILS
  let removed = 0
  for (const key of perKeyTail.keys()) {
    perKeyTail.delete(key)
    removed += 1
    if (removed >= excess) break
  }
}

/**
 * Bounded-parallel IDB write queue with per-key ordering.
 * Different keys may write concurrently (up to STORE_WRITE_CONCURRENCY);
 * the same key always serializes so two writers cannot race.
 * Failures on one key never poison later writes for that key.
 */
function enqueueStoreWrite(task, options = {}) {
  if (typeof task !== "function") {
    return Promise.resolve({ ok: false, error: "invalid-store-task" })
  }

  const key =
    normalizeStoreKey(typeof options.key === "string" ? options.key : null) ||
    resolveStoreKey(task)

  if (!key) {
    return enqueueUnbounded(task)
  }

  const previous = perKeyTail.get(key) || Promise.resolve()
  const run = previous.then(
    () => enqueueUnbounded(task),
    () => enqueueUnbounded(task)
  )
  // Keep the per-key chain alive even if a write rejects, so later stores proceed.
  const tracked = run.then(
    (value) => value,
    (error) => ({
      ok: false,
      error: error?.message || String(error || "store-write-failed")
    })
  )
  const chainLink = tracked.then(
    () => undefined,
    () => undefined
  )
  perKeyTail.set(key, chainLink)
  prunePerKeyTails()
  return tracked.finally(() => {
    if (perKeyTail.get(key) === chainLink) perKeyTail.delete(key)
  })
}

function getStoreQueueStats() {
  return {
    active,
    queued: waitQueue.length,
    perKeyTails: perKeyTail.size,
    completedTasks,
    rejectedTasks,
    droppedTasks,
    concurrency: resolveConcurrency(),
    maxQueueDepth: resolveMaxQueueDepth()
  }
}

ns.enqueueStoreWrite = enqueueStoreWrite
ns.getStoreQueueStats = getStoreQueueStats
})()
