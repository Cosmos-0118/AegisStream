/**
 * Run: node test/background/media/playlist-matrix.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

function loadModule(file, extra = {}) {
  const sandbox = {
    self: {},
    URL: global.URL,
    URLSearchParams: global.URLSearchParams,
    ...extra
  }
  vm.runInContext(fs.readFileSync(file, "utf8"), vm.createContext(sandbox))
  return sandbox.self.AegisBackground
}

const cacheKeysPath = path.join(__dirname, "../../../src/background/media/cache-keys.js")
const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const mapperPath = path.join(__dirname, "../../../src/background/media/manifest-mapper.js")
const matrixPath = path.join(__dirname, "../../../src/background/media/playlist-matrix.js")

const sandbox = { self: {}, URL: global.URL, URLSearchParams: global.URLSearchParams }
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(cacheKeysPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(mapperPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(matrixPath, "utf8"), vm.createContext(sandbox))
const matrixApi = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const matrix = matrixApi.buildPlaylistMatrix([
  {
    label: "480p",
    bandwidth: 800_000,
    segments: [
      "https://cdn.example.com/low/seg0.ts?a=1",
      "https://cdn.example.com/low/seg1.ts?a=1"
    ],
    mediaPlaylistUrl: "https://cdn.example.com/low/index.m3u8"
  },
  {
    label: "720p",
    bandwidth: 2_500_000,
    segments: [
      "https://cdn.example.com/mid/seg0.ts?b=1",
      "https://cdn.example.com/mid/seg1.ts?b=1"
    ],
    mediaPlaylistUrl: "https://cdn.example.com/mid/index.m3u8"
  }
])

assert(matrix.segmentCount === 2, "matrix aligns two segments")
assert(matrix.rows[1]["720p"].includes("/mid/seg1"), "index 1 maps to mid rung")
assert(
  matrixApi.getMatrixSegmentUrl(matrix, 0, "480p").includes("/low/seg0"),
  "lookup by index and rung"
)
assert(
  matrixApi.resolveRungLabelForMediaUrl(matrix, "https://cdn.example.com/mid/index.m3u8") === "720p",
  "media playlist resolves rung"
)
const adjacent = matrixApi.getAdjacentRungLabels(matrix, "720p")
assert(adjacent.includes("480p") && adjacent.length === 1, "adjacent rung below 720p")
assert(
  matrixApi.resolveMatrixAnchorIndex(matrix, 1, 2) === 1,
  "O(1) anchor index preserved on switch"
)

console.log("playlist-matrix.test.js: ok")
