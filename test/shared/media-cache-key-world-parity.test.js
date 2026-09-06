/**
 * The page world (src/page/media/media-cache-key-page.js) and the background
 * world (src/shared/media-cache-key.js) must compute the SAME invariant blob
 * key for the same URL, or a chunk stored from one world is never found by a
 * lookup from the other.
 *
 * Nothing ever assigns `AegisPageBridge.constants` in the extension (grep
 * confirms only readers exist in src/page), so the page world always falls
 * through to `extractInvariantBlobTail`'s literal default. The background
 * loads the real src/background/config/constants.js, where
 * MEDIA_CACHE_INVARIANT_TAIL_LEN is configured — so the background never
 * takes its OWN fallback branch either. Both fallbacks must therefore resolve
 * to the SAME value as the real configured constant, not to each other's
 * dead fallback formula (regression: a prior fix matched the page's literal
 * to the background's unreachable fallback formula instead of to the
 * configured value, silently breaking parity for every blob-tail length
 * outside a narrow coincidental band).
 *
 * Run: node test/shared/media-cache-key-world-parity.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, "../..")

function makeBackgroundNs() {
  const sandbox = { self: {}, URL }
  sandbox.globalThis = sandbox
  const ctx = vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(path.join(root, "src/background/config/constants.js"), "utf8"), ctx)
  vm.runInContext(fs.readFileSync(path.join(root, "src/shared/media-cache-key.js"), "utf8"), ctx)
  return sandbox.self.AegisBackground
}

function makePageNs() {
  // The page world genuinely has no `constants` assigned onto AegisPageBridge —
  // do not seed one here, or this test stops reflecting real runtime conditions.
  const sandbox = { globalThis: {}, location: { href: "https://example.com/" }, URL }
  sandbox.globalThis.location = sandbox.location
  vm.runInContext(
    fs.readFileSync(path.join(root, "src/page/media/media-cache-key-page.js"), "utf8"),
    vm.createContext(sandbox)
  )
  return sandbox.globalThis.AegisPageBridge
}

const background = makeBackgroundNs()
const page = makePageNs()

// Obfuscated blob segments across a range of lengths spanning the band where
// the two worlds' fallback formulas previously diverged (41-101, and >=104).
const lengths = [40, 41, 56, 60, 75, 90, 101, 103, 104, 120, 160, 200]
for (const len of lengths) {
  const segment = "a1B2c3D4".repeat(Math.ceil(len / 8)).slice(0, len)
  const url = `https://cdn.example.com/${segment}`
  const bgKey = background.buildMediaInvariantKey(url)
  const pageKey = page.buildMediaInvariantKey(url)
  assert(bgKey, `background must produce an invariant key for length ${len}`)
  assert(
    bgKey === pageKey,
    `blob invariant key mismatch at length ${len}: background=${bgKey} page=${pageKey}`
  )
}

console.log("media-cache-key-world-parity.test.js: all assertions passed")
