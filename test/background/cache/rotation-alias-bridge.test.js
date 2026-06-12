/**
 * Segment URL history + rotation alias bridging contracts.
 *
 * Run: node test/background/cache/rotation-alias-bridge.test.js
 */
"use strict"

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function mergeSegmentUrlHistory(previousHistory, previousSegments, newSegments, anchorIndex) {
  const history =
    previousHistory instanceof Map ? new Map(previousHistory) : new Map()
  if (!Array.isArray(previousSegments) || !Array.isArray(newSegments)) {
    return history
  }
  const maxDepth = 4
  const end = Math.min(previousSegments.length, newSegments.length)

  for (let i = 0; i < end; i += 1) {
    const oldUrl = previousSegments[i]
    const newUrl = newSegments[i]
    if (!oldUrl && !newUrl) continue
    const list = [...(history.get(i) || [])]
    if (oldUrl && oldUrl !== newUrl) {
      const oldNorm = String(oldUrl).split("#")[0]
      if (oldNorm && !list.includes(oldNorm)) list.push(oldNorm)
    }
    if (newUrl) {
      const newNorm = String(newUrl).split("#")[0]
      if (newNorm) {
        const without = list.filter((entry) => entry !== newNorm)
        history.set(i, [newNorm, ...without].slice(0, maxDepth))
        continue
      }
    }
    history.set(i, list.slice(0, maxDepth))
  }
  return history
}

const oldSeg = "https://cdn.example/old-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const newSeg = "https://cdn.example/new-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const history = mergeSegmentUrlHistory(new Map(), [oldSeg], [newSeg], 0)

assert(history.get(0)?.[0] === newSeg, "newest URL should be first")
assert(history.get(0)?.includes(oldSeg), "prior signed URL should be retained for fallback lookup")

const prev = new Array(142).fill("https://cdn.example/stable")
const next = new Array(142).fill("https://cdn.example/stable")
const farOld = "https://cdn.example/old-token-cccccccccccccccccccccccccccccccccccc"
const farNew = "https://cdn.example/new-token-dddddddddddddddddddddddddddddddddd"
prev[14] = farOld
next[14] = farNew
const farHistory = mergeSegmentUrlHistory(new Map(), prev, next, 32)
assert(farHistory.get(14)?.includes(farOld), "rotation history must cover indices far from anchor")

console.log("rotation-alias-bridge.test.js: all assertions passed")
