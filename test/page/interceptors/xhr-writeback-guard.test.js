/**
 * Run: node test/page/interceptors/xhr-writeback-guard.test.js
 */
"use strict"

function isAuthorizedForXhrWriteback(xhr) {
  if (xhr.__aegisChunkCaptured === true) return false
  return xhr.__aegisResponseSource === "network-native"
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

assert(!isAuthorizedForXhrWriteback({ __aegisResponseSource: "unknown" }), "unknown must block")
assert(!isAuthorizedForXhrWriteback({ __aegisResponseSource: null }), "null must block")
assert(!isAuthorizedForXhrWriteback({ __aegisResponseSource: "collapse" }), "collapse must block")
assert(!isAuthorizedForXhrWriteback({ __aegisResponseSource: "idb-hit" }), "idb-hit must block")
assert(!isAuthorizedForXhrWriteback({ __aegisResponseSource: "memory-hit" }), "memory-hit must block")
assert(
  isAuthorizedForXhrWriteback({ __aegisResponseSource: "network-native" }),
  "network-native must authorize writeback"
)
assert(
  !isAuthorizedForXhrWriteback({ __aegisChunkCaptured: true, __aegisResponseSource: "network-native" }),
  "chunkCaptured belt must block even when network-native"
)

console.log("xhr-writeback-guard.test.js: all assertions passed")
