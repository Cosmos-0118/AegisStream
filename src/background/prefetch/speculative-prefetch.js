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

async function fetchMediaPlaylistSegments(variantUrl) {
  const normalized = stripHash(variantUrl)
  if (!normalized) return null
  try {
    const res = await fetch(normalized, {
      credentials: "include",
      cache: "no-store",
      priority: "low"
    })
    if (!res.ok) return null
    const text = await res.text()
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
      const media = await fetchMediaPlaylistSegments(variant.url)
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

  const runway = Number(tabState.bufferRunwaySec)
  if (!Number.isFinite(runway) || runway < constants.SPECULATIVE_MIN_RUNWAY_SEC) return []

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

  const urls = []
  const ahead = Math.max(1, Number(limits.segmentsAhead) || 1)
  for (let offset = 1; offset <= ahead; offset += 1) {
    const index = tabState.anchorIndex + offset
    for (const label of adjacent) {
      const url = getMatrixSegmentUrl(matrix, index, label)
      if (url) urls.push({ url, fromRung: activeLabel, toRung: label })
    }
  }

  return urls.slice(0, limits.maxUrls)
}

async function scheduleSpeculativeRungPrefetch(tabId, tabState = null) {
  if (!state.settings.enabled || !state.settings.prefetchEnabled) return
  if (!isTabEligibleForPrefetch(tabId)) return
  const resolved = tabState || state.playlistByTab.get(tabId)
  if (!resolved) return

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
    delegated = await ns.delegatePrefetchToPage(tabId, urls)
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

  resolved.lastSpeculativePrefetchAt = Date.now()
  resolved.updatedAt = Date.now()
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
  if (label) tabState.activeRungLabel = label
}

ns.ingestMasterPlaylist = ingestMasterPlaylist
ns.scheduleSpeculativeRungPrefetch = scheduleSpeculativeRungPrefetch
ns.maybeScheduleSpeculativePrefetch = maybeScheduleSpeculativePrefetch
ns.applyMatrixToTabState = applyMatrixToTabState
})()
