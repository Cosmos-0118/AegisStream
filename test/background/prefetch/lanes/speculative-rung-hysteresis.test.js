/**
 * Run: node test/background/prefetch/lanes/speculative-rung-hysteresis.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const srcPath = path.join(
  __dirname,
  "../../../../src/background/prefetch/lanes/speculative-prefetch.js"
)

function makeSandbox(nowRef) {
  const sandbox = {
    self: {
      AegisBackground: {
        constants: {
          VARIANT_SWITCH_COOLDOWN_MS: 8000,
          SPECULATIVE_MATRIX_MAX_RUNGS: 6,
          SPECULATIVE_CONTINUOUS_RUNWAY_FLOOR_SEC: 5,
          SPECULATIVE_CYCLE_MIN_MS: 0,
          SPECULATIVE_SEGMENTS_AHEAD: 2,
          SPECULATIVE_MAX_URLS_PER_CYCLE: 10
        },
        state: { settings: { enabled: true, speculativePrefetchEnabled: true } },
        addLog: () => {},
        stripHash: (u) => (typeof u === "string" ? u.split("#")[0] : null),
        bumpActivity: () => {},
        parseHlsPlaylist: () => ({ kind: "media", segments: [] }),
        normalizeSegments: (s) => s,
        buildPlaylistMatrix: () => null,
        labelFromVariantMeta: () => "rung-1",
        resolveRungLabelForMediaUrl(matrix, mediaPlaylistUrl) {
          return matrix?.mediaUrlToRung?.[mediaPlaylistUrl] || null
        },
        getAdjacentRungLabels(matrix, activeLabel) {
          const labels = matrix?.rungLabels || []
          const idx = labels.indexOf(activeLabel)
          if (idx < 0) return labels.filter((l) => l !== activeLabel)
          const out = []
          if (idx > 0) out.push(labels[idx - 1])
          if (idx < labels.length - 1) out.push(labels[idx + 1])
          return out
        },
        getMatrixSegmentUrl(matrix, index, label) {
          return matrix?.rows?.[index]?.[label] || null
        },
        isTabEligibleForPrefetch: () => true,
        isReactivePrefetchTab: () => false,
        getTabBufferTier: () => "normal",
        isContinuousSpeculationAllowed: () => true,
        evaluateContinuousSpeculation: () => ({
          allowSpeculation: true,
          score: 0.5,
          priorityTier: "NORMAL"
        }),
        resolveSpeculativeDenyReason: () => null,
        isSpeculativePrefetchAllowed: () => true,
        getAdaptiveLimits: () => ({ segmentsAhead: 2, maxUrls: 10, mode: "full" }),
        resolveCachedChunk: async () => null,
        getManifestUrlSignature: () => null
      }
    },
    Date: class extends Date {
      static now() {
        return nowRef.value
      }
    }
  }
  sandbox.globalThis = sandbox
  return sandbox
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const nowRef = { value: 1_000_000 }
const sandbox = makeSandbox(nowRef)
sandbox.self.AegisBackground.constants.VARIANT_SWITCH_COOLDOWN_MS = 2000
vm.runInContext(fs.readFileSync(srcPath, "utf8"), vm.createContext(sandbox))

const applyMatrixToTabState = sandbox.self.AegisBackground.applyMatrixToTabState
assert(typeof applyMatrixToTabState === "function", "applyMatrixToTabState should exist")

const matrix = {
  rungLabels: ["360p", "720p", "1080p"],
  rungByLabel: {
    "1080p": { bandwidth: 6000000 },
    "720p": { bandwidth: 3500000 },
    "360p": { bandwidth: 900000 }
  },
  mediaUrlToRung: {
    "m1080": "1080p",
    "m720": "720p",
    "m360": "360p"
  },
  rows: [
    { "360p": "u360-0", "720p": "u720-0", "1080p": "u1080-0" },
    { "360p": "u360-1", "720p": "u720-1", "1080p": "u1080-1" }
  ]
}

const tabState = {
  playlistMatrix: matrix,
  activeRungLabel: "1080p",
  lastQualitySwitchAt: nowRef.value
}

// 1) Immediate downgrade during hold window should be ignored (8s hold, not VARIANT_SWITCH_COOLDOWN_MS).
nowRef.value += 3000
applyMatrixToTabState(tabState, "m360")
assert(tabState.activeRungLabel === "1080p", "downgrade must be held during 8s rung hold")

// 2) After cooldown, downgrade requires 3 confirmations.
nowRef.value += 6000
applyMatrixToTabState(tabState, "m360")
assert(tabState.activeRungLabel === "1080p", "first downgrade sample must not switch")
applyMatrixToTabState(tabState, "m360")
assert(tabState.activeRungLabel === "1080p", "second downgrade sample must not switch")
applyMatrixToTabState(tabState, "m360")
assert(tabState.activeRungLabel === "360p", "third downgrade sample should switch")

// 3) Upgrade should require only 2 confirmations.
tabState.activeRungLabel = "360p"
applyMatrixToTabState(tabState, "m720")
assert(tabState.activeRungLabel === "360p", "first upgrade sample must not switch")
applyMatrixToTabState(tabState, "m720")
assert(tabState.activeRungLabel === "720p", "second upgrade sample should switch")

const collectSpeculativeRungUrls = sandbox.self.AegisBackground.collectSpeculativeRungUrls
if (typeof collectSpeculativeRungUrls === "function") {
  tabState.activeRungLabel = "1080p"
  tabState.anchorIndex = 0
  tabState.playlistMatrix = matrix
  tabState.bufferRunwaySec = 30
  tabState.lastQualitySwitchAt = nowRef.value
  tabState.variantSwitchGraceUntil = 0
  tabState.lastSpeculativePrefetchAt = 0
  const targets = collectSpeculativeRungUrls(1, tabState)
  assert(
    !targets.some((item) => item.toRung === "360p"),
    "speculative prefetch must skip downgrade rungs during quality hold"
  )
}

console.log("speculative-rung-hysteresis.test.js: all assertions passed")
