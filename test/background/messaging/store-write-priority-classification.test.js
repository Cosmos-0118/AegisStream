/**
 * Player-observed writes (fetch-tee/fetch-clone/xhr-sync/xhr-load) must stay
 * "high" priority so they can preempt queued speculative work; only genuinely
 * speculative sources (prefetch, and the deduplicated collapse backfill) are
 * "low" and eligible for eviction under store-queue backpressure. Regression:
 * a broad /^(?:prefetch|depth)/i regex classified xhr-collapse-backfill (and
 * any future/typo'd source) as "high", degrading the preemption scheme toward
 * a no-op.
 *
 * Run: node test/background/messaging/store-write-priority-classification.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const src = fs.readFileSync(
  path.join(__dirname, "../../../src/background/messaging/message-router.js"),
  "utf8"
)

const setMatch = src.match(/const SPECULATIVE_CAPTURE_SOURCES = new Set\(\[[^\]]*\]\)/)
assert(setMatch, "SPECULATIVE_CAPTURE_SOURCES declaration not found in message-router.js")
// eslint-disable-next-line no-eval
const SPECULATIVE_CAPTURE_SOURCES = eval(setMatch[0].replace("const SPECULATIVE_CAPTURE_SOURCES = ", ""))

function priorityFor(captureSource) {
  return SPECULATIVE_CAPTURE_SOURCES.has(String(captureSource || "").toLowerCase()) ? "low" : "high"
}

const playerObservedSources = ["fetch-tee", "fetch-clone", "xhr-sync", "xhr-load"]
for (const source of playerObservedSources) {
  assert(priorityFor(source) === "high", `${source} (player-observed) must be high priority`)
}

assert(priorityFor("prefetch") === "low", "prefetch must be low priority")
assert(priorityFor("xhr-collapse-backfill") === "low", "xhr-collapse-backfill must be low priority")

// Unknown/typo'd sources default to the safe choice (high), never silently "low".
assert(priorityFor("xhr-cllapse-backfill") === "high", "a typo'd source must not silently become low priority")
assert(priorityFor(undefined) === "high", "a missing captureSource must default to high priority")

// Regression: core.js normalizes captureSource to "unknown" before it ever
// reaches the background, using its own separate allowlist (CHUNK_CAPTURE_SOURCES).
// A source classified "low" here is silently neutralized back to "high" if that
// allowlist doesn't also carry it — exactly what happened when
// "xhr-collapse-backfill" was added to SPECULATIVE_CAPTURE_SOURCES here without
// also adding it to core.js's CHUNK_CAPTURE_SOURCES.
const coreSrc = fs.readFileSync(
  path.join(__dirname, "../../../src/page/bridge/core.js"),
  "utf8"
)
const coreSetMatch = coreSrc.match(/const CHUNK_CAPTURE_SOURCES = new Set\(\[[^\]]*\]\)/)
assert(coreSetMatch, "CHUNK_CAPTURE_SOURCES declaration not found in core.js")
// eslint-disable-next-line no-eval
const CHUNK_CAPTURE_SOURCES = eval(coreSetMatch[0].replace("const CHUNK_CAPTURE_SOURCES = ", ""))

for (const source of SPECULATIVE_CAPTURE_SOURCES) {
  assert(
    CHUNK_CAPTURE_SOURCES.has(source),
    `"${source}" is in SPECULATIVE_CAPTURE_SOURCES but not in core.js's CHUNK_CAPTURE_SOURCES — ` +
      `it will be normalized to "unknown" before reaching the background and silently classified "high"`
  )
}

console.log("store-write-priority-classification.test.js: all assertions passed")
