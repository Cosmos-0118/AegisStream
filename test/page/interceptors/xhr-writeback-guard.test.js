/**
 * Run: node test/page/interceptors/xhr-writeback-guard.test.js
 */
"use strict"

const INTERNAL_AEGIS_RESPONSE_SOURCES = new Set([
  "collapse",
  "idb-hit",
  "cache",
  "memory-hit",
  "wire-collapse"
])

function isInternalAegisResponseSource(source) {
  return typeof source === "string" && INTERNAL_AEGIS_RESPONSE_SOURCES.has(source)
}

function shouldSuppressXhrWriteback(xhr) {
  if (xhr.__aegisServedFromCache === true) return true
  if (xhr.__aegisChunkCaptured === true) return true
  return isInternalAegisResponseSource(xhr.__aegisResponseSource)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(shouldSuppressXhrWriteback({ __aegisResponseSource: "collapse" }), "collapse must suppress")
assert(shouldSuppressXhrWriteback({ __aegisResponseSource: "idb-hit" }), "idb-hit must suppress")
assert(shouldSuppressXhrWriteback({ __aegisResponseSource: "cache" }), "legacy cache alias must suppress")
assert(
  !shouldSuppressXhrWriteback({ __aegisResponseSource: null }),
  "native network must allow writeback path"
)
assert(
  !shouldSuppressXhrWriteback({ __aegisResponseSource: "network-native" }),
  "explicit network-native must allow writeback path"
)
assert(
  shouldSuppressXhrWriteback({ __aegisChunkCaptured: true, __aegisResponseSource: null }),
  "chunkCaptured belt must suppress"
)

console.log("xhr-writeback-guard.test.js: all assertions passed")
