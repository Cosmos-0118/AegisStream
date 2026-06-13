(() => {
var ns = (self.AegisBackground ||= {})
const {
  constants,
  state,
  addLog,
  stripHash,
  bumpActivity,
  parseHlsPlaylist,
  normalizeSegments,
  buildPlaylistMatrix,
  labelFromVariantMeta,
  resolveRungLabelForMediaUrl,
  getAdjacentRungLabels,
  getMatrixSegmentUrl,
  isTabEligibleForPrefetch,
  isReactivePrefetchTab,
  getTabBufferTier,
  resolveCachedChunk,
  getManifestUrlSignature
} = ns

const TIER_EMERGENCY = "emergency"
const TIER_AGGRESSIVE = "aggressive"
const RUNG_SWITCH_MIN_HOLD_MS = 8_000
const RUNG_SWITCH_CONFIRM_UPGRADE = 2
const RUNG_SWITCH_CONFIRM_DOWNGRADE = 3

function isRungDowngrade(matrix, fromLabel, toLabel) {
  if (!fromLabel || !toLabel || fromLabel === toLabel) return false
  const fromBw = Number(matrix?.rungByLabel?.[fromLabel]?.bandwidth || 0)
  const toBw = Number(matrix?.rungByLabel?.[toLabel]?.bandwidth || 0)
  return fromBw > 0 && toBw > 0 && toBw < fromBw
}

function isQualityRungHoldActive(tabState) {
  if (!tabState) return false
  const holdUntil = Number(tabState.lastQualitySwitchAt || 0) + RUNG_SWITCH_MIN_HOLD_MS
  return Date.now() < holdUntil
}

function isVariantSwitchGraceActive(tabState) {
  if (!tabState) return false
  return Date.now() < Number(tabState.variantSwitchGraceUntil || 0)
}

function shouldSkipSpeculativeDowngradeRung(tabState, matrix, activeLabel, candidateLabel) {
  if (!isRungDowngrade(matrix, activeLabel, candidateLabel)) return false
  return isQualityRungHoldActive(tabState) || isVariantSwitchGraceActive(tabState)
}

function normalizeVariantEntry(entry) {
  if (typeof entry === "string") {
    return { url: entry, bandwidth: 0, resolution: null, label: null }
  }
  if (!entry || typeof entry.url !== "string") return null
  return {
    url: entry.url,
    bandwidth: Number(entry.bandwidth) || 0,
    resolution: entry.resolution || null,
    label: entry.label || null
  }
}

function getRungLabelForSegmentUrl(matrix, url) {
  if (!matrix?.rows?.length || !url) return null
  const target = stripHash(url)
  const targetSig = getManifestUrlSignature(url)
  for (const row of matrix.rows) {
    for (const [label, segmentUrl] of Object.entries(row)) {
      if (!segmentUrl) continue
      if (stripHash(segmentUrl) === target) return label
      if (targetSig && getManifestUrlSignature(segmentUrl) === targetSig) return label
    }
  }
  return null
}

async function fetchMediaPlaylistSegments(tabId, variantUrl) {
  const normalized = stripHash(variantUrl)
  if (!normalized) return null
  try {
    let text = null
    if (Number.isFinite(tabId)) {
      try {
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: async (url) => {
            try {
              const res = await fetch(url, { credentials: "include" })
              return res.ok ? await res.text() : null
            } catch {
              return null
            }
          },
          args: [normalized],
          world: "MAIN"
        })
        text = injection?.result
      } catch (e) {
        // Fallback
      }
    }
    
    if (!text) {
      const res = await fetch(normalized, {
        credentials: "include",
        cache: "no-store",
        priority: "low"
      })
      if (!res.ok) return null
      text = await res.text()
    }
    
    if (!text) return null

    const parsed = parseHlsPlaylist(text, normalized)
    if (parsed.kind !== "media" || !parsed.segments.length) return null
    return {
      mediaPlaylistUrl: normalized,
      segments: normalizeSegments(parsed.segments),
      bandwidth: 0,
      resolution: null,
      label: null
    }
  } catch {
    return null
  }
}

async function ingestMasterPlaylist(tabId, masterUrl, variantEntries) {
  if (!state.settings.enabled) return null
  if (isReactivePrefetchTab(tabId)) return null
  const variants = (Array.isArray(variantEntries) ? variantEntries : [])
    .map(normalizeVariantEntry)
    .filter(Boolean)
    .slice(0, constants.SPECULATIVE_MATRIX_MAX_RUNGS)
  if (!variants.length) return null

  const results = await Promise.all(
    variants.map(async (variant, index) => {
      const media = await fetchMediaPlaylistSegments(tabId, variant.url)
      if (!media) return null
      return {
        label: variant.label || labelFromVariantMeta(variant, index),
        bandwidth: variant.bandwidth,
        resolution: variant.resolution,
        mediaPlaylistUrl: media.mediaPlaylistUrl,
        segments: media.segments
      }
    })
  )

  const rungs = results.filter(Boolean)
  if (!rungs.length) return null

  const matrix = buildPlaylistMatrix(rungs)
  if (!matrix.rows.length) return null

  let tabState = state.playlistByTab.get(tabId)
  if (!tabState) {
    tabState = { segments: [], updatedAt: Date.now() }
    state.playlistByTab.set(tabId, tabState)
  }

  tabState.playlistMatrix = matrix
  tabState.masterPlaylistUrl = stripHash(masterUrl)
  tabState.matrixBuiltAt = matrix.builtAt
  tabState.updatedAt = Date.now()

  if (tabState.mediaPlaylistUrl && typeof ns.applyMatrixToTabState === "function") {
    ns.applyMatrixToTabState(tabState, tabState.mediaPlaylistUrl)
  }

  addLog(
    "INFO",
    `Built speculative playlist matrix on tab ${tabId}: ${matrix.rungLabels.join(", ")} × ${matrix.segmentCount} segments`
  )
  bumpActivity("speculativeMatrixBuilt", 1)
  return matrix
}

function collectSpeculativeRungUrls(tabId, tabState) {
  if (typeof ns.isSpeculativePrefetchAllowed === "function" && !ns.isSpeculativePrefetchAllowed()) {
    return []
  }
  if (!state.settings.speculativePrefetchEnabled) return []
  if (!tabState?.playlistMatrix?.rows?.length) return []
  if (typeof tabState.anchorIndex !== "number" || tabState.anchorIndex < 0) return []

  const congestion =
    tabState.congestionDirectives ||
    (typeof ns.computeCongestionDirectivesForTab === "function"
      ? ns.computeCongestionDirectivesForTab(tabId)
      : null)
  const runway = Number(tabState.bufferRunwaySec)
  const continuousFloor =
    Number(constants.SPECULATIVE_CONTINUOUS_RUNWAY_FLOOR_SEC) ||
    Number(constants.SPECULATIVE_MIN_RUNWAY_SEC) ||
    5
  if (!Number.isFinite(runway) || runway < continuousFloor) return []

  if (
    typeof ns.isContinuousSpeculationAllowed === "function" &&
    !ns.isContinuousSpeculationAllowed(tabId, tabState)
  ) {
    return []
  }

  const tier = typeof getTabBufferTier === "function" ? getTabBufferTier(tabId) : null
  if (tier === TIER_EMERGENCY || tier === TIER_AGGRESSIVE) return []

  const now = Date.now()
  const lastAt = Number(tabState.lastSpeculativePrefetchAt || 0)
  if (now - lastAt < constants.SPECULATIVE_CYCLE_MIN_MS) return []

  const limits =
    typeof ns.getAdaptiveLimits === "function"
      ? ns.getAdaptiveLimits()
      : {
          segmentsAhead: constants.SPECULATIVE_SEGMENTS_AHEAD,
          maxUrls: constants.SPECULATIVE_MAX_URLS_PER_CYCLE
        }

  if (!limits.segmentsAhead || !limits.maxUrls) return []

  const matrix = tabState.playlistMatrix
  const activeLabel =
    tabState.activeRungLabel ||
    resolveRungLabelForMediaUrl(matrix, tabState.mediaPlaylistUrl) ||
    matrix.rungLabels[Math.floor(matrix.rungLabels.length / 2)]

  const adjacent = getAdjacentRungLabels(matrix, activeLabel)
  if (!adjacent.length) return []

  const continuousEval =
    typeof ns.evaluateContinuousSpeculation === "function"
      ? ns.evaluateContinuousSpeculation(tabId, tabState)
      : null

  const urls = []
  let ahead = Math.max(1, Number(limits.segmentsAhead) || 1)
  if (congestion) {
    const congestionAhead = Number(congestion.speculativeSegmentsAhead) || 0
    if (congestion.speculativeAllowed === true && congestionAhead > 0) {
      ahead = Math.min(ahead, congestionAhead)
    } else if (continuousEval?.priorityTier === "CONSERVATIVE_LQ") {
      ahead = Math.min(ahead, 1)
    }
    if (!ahead) return []
  }
  for (let offset = 1; offset <= ahead; offset += 1) {
    const index = tabState.anchorIndex + offset
    for (const label of adjacent) {
      if (shouldSkipSpeculativeDowngradeRung(tabState, matrix, activeLabel, label)) {
        continue
      }
      const url = getMatrixSegmentUrl(matrix, index, label)
      if (url) {
        urls.push({
          url,
          segmentIndex: index,
          fromRung: activeLabel,
          toRung: label
        })
      }
    }
  }

  return urls.slice(0, limits.maxUrls)
}

async function scheduleSpeculativeRungPrefetch(tabId, tabState = null) {
  if (!state.settings.enabled || !state.settings.prefetchEnabled) return
  if (!isTabEligibleForPrefetch(tabId)) return
  const resolved = tabState || state.playlistByTab.get(tabId)
  if (!resolved) return
  if (typeof ns.isRescueModeActive === "function" && ns.isRescueModeActive(resolved)) {
    return
  }
  if (typeof ns.resolveSpeculativeDenyReason === "function") {
    const denyReason = ns.resolveSpeculativeDenyReason(tabId, resolved)
    if (denyReason) {
      if (typeof ns.notePainSpeculativeDenied === "function") {
        ns.notePainSpeculativeDenied(denyReason)
      }
      return
    }
  }
  const continuousEval =
    typeof ns.evaluateContinuousSpeculation === "function"
      ? ns.evaluateContinuousSpeculation(tabId, resolved)
      : null
  if (typeof ns.computeCongestionDirectivesForTab === "function") {
    const directives = ns.computeCongestionDirectivesForTab(tabId)
    if (directives?.speculativeAllowed !== true && continuousEval?.allowSpeculation !== true) {
      if (typeof ns.notePainCongestionThrottle === "function") {
        ns.notePainCongestionThrottle(
          `speculative blocked, tier=${directives?.activeTierName || "unknown"}`
        )
      }
      return
    }
  }

  const targets = collectSpeculativeRungUrls(tabId, resolved)
  if (!targets.length) return

  const uncached = []
  for (const item of targets) {
    const existing = await resolveCachedChunk(item.url)
    if (!existing) uncached.push(item)
  }
  if (!uncached.length) return

  if (typeof ns.registerSpeculativePrefetch === "function") {
    for (const item of uncached) {
      ns.registerSpeculativePrefetch({
        url: item.url,
        tabId,
        source: "speculative-rung",
        fromRung: item.fromRung,
        toRung: item.toRung
      })
    }
  }

  const urls = uncached.map((item) => item.url)
  let delegated = false
  if (typeof ns.delegatePrefetchToPage === "function") {
    delegated = await ns.delegatePrefetchToPage(tabId, urls, { source: "speculative-rung" })
  } else {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "AegisStream:PrefetchSegments",
        urls,
        source: "speculative-rung"
      })
      delegated = true
    } catch {
      delegated = false
    }
  }

  if (!delegated) return

  const confidence =
    typeof ns.getPredictionConfidence === "function" ? ns.getPredictionConfidence() : 0
  const directives =
    typeof ns.computeCongestionDirectivesForTab === "function"
      ? ns.computeCongestionDirectivesForTab(tabId)
      : null
  const networkTier = String(
    directives?.activeTierName || resolved.bufferTier || "NOMINAL"
  ).toUpperCase()

  if (typeof ns.recordSpeculationAllocated === "function") {
    const seenIndices = new Set()
    for (const item of uncached) {
      if (typeof item.segmentIndex !== "number" || seenIndices.has(item.segmentIndex)) continue
      seenIndices.add(item.segmentIndex)
      ns.recordSpeculationAllocated({
        tab_id: tabId,
        confidence,
        buffer_runway_sec: Number(resolved.bufferRunwaySec) || 0,
        calculated_score: Number(continuousEval?.score) || 0,
        assigned_tier: continuousEval?.priorityTier || "CONSERVATIVE_LQ",
        target_segment_index: item.segmentIndex,
        network_tier: networkTier,
        bitrate_tier_used: item.toRung || null
      })
    }
  }

  resolved.lastSpeculativePrefetchAt = Date.now()
  resolved.updatedAt = Date.now()
  if (continuousEval?.allowSpeculation && typeof ns.recordDecision === "function") {
    ns.recordDecision(
      "speculative",
      "scheduled",
      `score=${Math.round((continuousEval.score || 0) * 100)}%, tier=${continuousEval.priorityTier || "unknown"}, urls=${uncached.length}`
    )
  }
  bumpActivity("speculativePrefetchScheduled", uncached.length)

  const limits = typeof ns.getAdaptiveLimits === "function" ? ns.getAdaptiveLimits() : null
  const modeLabel = limits?.mode ? `, adaptive=${limits.mode}` : ""
  addLog(
    "INFO",
    `Speculative multi-rung prefetch: ${uncached.length} segments (tab ${tabId}, runway=${Number(resolved.bufferRunwaySec).toFixed(1)}s${modeLabel})`
  )
}

function maybeScheduleSpeculativePrefetch(tabId) {
  void scheduleSpeculativeRungPrefetch(tabId)
}

function applyMatrixToTabState(tabState, mediaPlaylistUrl) {
  if (!tabState?.playlistMatrix || !mediaPlaylistUrl) return
  const label = resolveRungLabelForMediaUrl(tabState.playlistMatrix, mediaPlaylistUrl)
  if (!label) return
  if (
    typeof ns.isTabInWarmRecoveryRungConfirm === "function" &&
    ns.isTabInWarmRecoveryRungConfirm(tabState)
  ) {
    const needed = Number(ns.constants?.WARM_RECOVERY_RUNG_CONFIRM_SAMPLES) || 3
    const samples = Array.isArray(tabState.warmRecoveryRungSamples)
      ? tabState.warmRecoveryRungSamples
      : []
    samples.push(label)
    if (samples.length > needed) samples.splice(0, samples.length - needed)
    tabState.warmRecoveryRungSamples = samples
    const confirmed =
      samples.length >= needed && samples.every((entry) => entry === label)
    if (!confirmed) return
    tabState.warmRecovery = false
    tabState.warmRecoveryRungSamples = []
  }

  const currentLabel = tabState.activeRungLabel || null
  if (!currentLabel) {
    tabState.activeRungLabel = label
    tabState.lastQualitySwitchAt = Date.now()
    tabState.pendingRungLabel = null
    tabState.pendingRungSamples = 0
    tabState.pendingRungFirstAt = 0
    return
  }

  if (currentLabel === label) {
    tabState.pendingRungLabel = null
    tabState.pendingRungSamples = 0
    tabState.pendingRungFirstAt = 0
    return
  }

  const rungByLabel = tabState.playlistMatrix?.rungByLabel || {}
  const currentBandwidth = Number(rungByLabel[currentLabel]?.bandwidth || 0)
  const nextBandwidth = Number(rungByLabel[label]?.bandwidth || 0)
  const isDowngrade =
    Number.isFinite(currentBandwidth) &&
    Number.isFinite(nextBandwidth) &&
    currentBandwidth > 0 &&
    nextBandwidth > 0 &&
    nextBandwidth < currentBandwidth

  const now = Date.now()
  const holdUntil = Number(tabState.lastQualitySwitchAt || 0) + RUNG_SWITCH_MIN_HOLD_MS

  // During hold, ignore opportunistic downgrades from transient playlist churn.
  if (isDowngrade && now < holdUntil) {
    return
  }

  if (tabState.pendingRungLabel !== label) {
    tabState.pendingRungLabel = label
    tabState.pendingRungSamples = 1
    tabState.pendingRungFirstAt = now
    return
  }

  tabState.pendingRungSamples = Number(tabState.pendingRungSamples || 0) + 1
  const requiredSamples = isDowngrade
    ? RUNG_SWITCH_CONFIRM_DOWNGRADE
    : RUNG_SWITCH_CONFIRM_UPGRADE

  if (tabState.pendingRungSamples < requiredSamples) {
    return
  }

  tabState.activeRungLabel = label
  tabState.lastQualitySwitchAt = now
  tabState.pendingRungLabel = null
  tabState.pendingRungSamples = 0
  tabState.pendingRungFirstAt = 0

  if (typeof addLog === "function") {
    const direction = isDowngrade ? "downshift" : "upshift"
    addLog(
      "DEBUG",
      `Rung switch ${direction} confirmed: ${currentLabel} -> ${label} (samples=${requiredSamples})`
    )
  }
}

ns.ingestMasterPlaylist = ingestMasterPlaylist
ns.scheduleSpeculativeRungPrefetch = scheduleSpeculativeRungPrefetch
ns.maybeScheduleSpeculativePrefetch = maybeScheduleSpeculativePrefetch
ns.applyMatrixToTabState = applyMatrixToTabState
ns.collectSpeculativeRungUrls = collectSpeculativeRungUrls
ns.shouldSkipSpeculativeDowngradeRung = shouldSkipSpeculativeDowngradeRung
})()
