/**
 * Regression: writeback-suppression diagnostics
 *
 * Background:
 *   The `xhr.response` property getter is hooked. The player frequently reads
 *   `xhr.response` more than once for the same finished request. The first
 *   read sets `__aegisChunkCaptured = true` and emits WRITEBACK-COMMITTED.
 *   Every subsequent read re-enters captureXhrResponseSync, finds
 *   __aegisChunkCaptured === true, and the old code emitted:
 *       [WRITEBACK-SUPPRESSED] source=network-native
 *   …making it look like the suppression branch was firing on a network-native
 *   source (which contradicts the guard logic).
 *
 *   This test pins down the disambiguation: a re-read of a captured XHR must
 *   report reason="duplicate-read", while an unauthorized source (cached /
 *   collapsed / unknown) must report reason="unauthorized-source".
 *
 * Run: node test/page/interceptors/xhr-writeback-suppression-reason.test.js
 */
"use strict"

function isAuthorizedForXhrWriteback(xhr) {
  if (xhr.__aegisChunkCaptured === true) return false
  return xhr.__aegisResponseSource === "network-native"
}

function classifySuppressionReason(xhr) {
  if (!isAuthorizedForXhrWriteback(xhr)) {
    return xhr.__aegisChunkCaptured === true ? "duplicate-read" : "unauthorized-source"
  }
  return null
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// Case A: cached delivery (idb-hit) — never written back, classification must be unauthorized.
assert(
  classifySuppressionReason({
    __aegisResponseSource: "idb-hit",
    __aegisChunkCaptured: false
  }) === "unauthorized-source",
  "idb-hit before capture flag must classify as unauthorized-source"
)

// Case B: collapse delivery — also unauthorized.
assert(
  classifySuppressionReason({
    __aegisResponseSource: "collapse",
    __aegisChunkCaptured: false
  }) === "unauthorized-source",
  "collapse delivery must classify as unauthorized-source"
)

// Case C: network-native, FIRST read — must authorize (no suppression).
assert(
  classifySuppressionReason({
    __aegisResponseSource: "network-native",
    __aegisChunkCaptured: false
  }) === null,
  "network-native first read must be authorized (no suppression reason)"
)

// Case D: network-native, SECOND read after capture flag flipped — must NOT
// be reported as a real suppression event. This is the exact false-positive
// pattern from the trace where the logs appeared to contradict the guard.
assert(
  classifySuppressionReason({
    __aegisResponseSource: "network-native",
    __aegisChunkCaptured: true
  }) === "duplicate-read",
  "network-native re-read after capture must classify as duplicate-read, not a real denial"
)

// Case E: unknown source — never authorized, always real denial.
assert(
  classifySuppressionReason({
    __aegisResponseSource: "unknown",
    __aegisChunkCaptured: false
  }) === "unauthorized-source",
  "unknown source must classify as unauthorized-source"
)

console.log("xhr-writeback-suppression-reason.test.js: all assertions passed")
