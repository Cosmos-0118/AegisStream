/**
 * Two confirmed cache-key collisions, found during senior review of the
 * range/query-selector work and fixed alongside it:
 *
 * 1. buildByteRangeCacheKey fell back to `${hostname}${pathname}` (dropping
 *    the query string) whenever no invariant media identity existed. Two
 *    distinct renditions sharing host+path (e.g. ?itag=137 video vs
 *    ?itag=140 audio) produced the identical range| key, so one stream's
 *    bytes could be served for the other's range request.
 *
 * 2. buildCacheKeyVariants pushed a path-only alias whenever the URL had no
 *    *identity* query param — but that included URLs whose query carried an
 *    unrecognized *functional* selector such as ?quality=720 vs
 *    ?quality=1080, which then collapsed onto the same path-only key.
 *
 * Run: node test/background/media/cache-key-collision-regressions.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const root = path.join(__dirname, "../../..")
const sandbox = { self: {}, URL, URLSearchParams }
sandbox.globalThis = sandbox
const ctx = vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(root, "src/background/config/constants.js"), "utf8"), ctx)
vm.runInContext(fs.readFileSync(path.join(root, "src/shared/media-cache-key.js"), "utf8"), ctx)
vm.runInContext(fs.readFileSync(path.join(root, "src/background/media/cache-keys.js"), "utf8"), ctx)
const ns = sandbox.self.AegisBackground

// ── 1. Distinct renditions sharing host+path must not share a range| key ──
{
  const videoKey = ns.resolveByteRangeCacheKey(
    "https://rr3---sn-x.googlevideo.com/videoplayback?itag=137&id=abc",
    "bytes=0-1023"
  )
  const audioKey = ns.resolveByteRangeCacheKey(
    "https://rr3---sn-x.googlevideo.com/videoplayback?itag=140&id=abc",
    "bytes=0-1023"
  )
  assert(videoKey && audioKey, "both range keys must resolve")
  assert(
    videoKey !== audioKey,
    `distinct renditions on the same host+path must not collide: ${videoKey} === ${audioKey}`
  )
}

// ── 2. A quality/lang-style selector must not collapse via the path-only alias.
// Use a path shape with no HLS/blob invariant identity (buildMediaInvariantKey
// returns null for /videoplayback), so this isolates the path-only-alias fix
// from the separate invariant-key layer, which treats path-tail as identity.
{
  const q720 = ns.buildCacheKeyVariants("https://cdn.example.com/videoplayback?quality=720")
  const q1080 = ns.buildCacheKeyVariants("https://cdn.example.com/videoplayback?quality=1080")
  const shared = q720.filter((key) => q1080.includes(key))
  assert(
    shared.length === 0,
    `?quality=720 and ?quality=1080 must not share any cache key variant, but share: ${shared.join(", ")}`
  )
  assert(
    !q720.includes("https://cdn.example.com/videoplayback"),
    "a URL with an unrecognized query selector must not emit the bare path-only variant"
  )
}

// ── 2b. Volatile-only / identity-only params still get the safe path-only alias ──
{
  const withTracking = ns.buildCacheKeyVariants("https://cdn.example.com/videoplayback?_nc_stat=1")
  assert(
    withTracking.includes("https://cdn.example.com/videoplayback"),
    "a purely volatile/tracking param must still allow the path-only alias"
  )
}

console.log("cache-key-collision-regressions.test.js: all assertions passed")
