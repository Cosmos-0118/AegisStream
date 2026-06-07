(() => {
var ns = (self.AegisBackground ||= {})
const { state } = ns

/**
 * Structural identity for HLS/DASH segment URLs: origin + pathname only.
 * Volatile tokens (?expires, &sig, etc.) must not affect playlist order lookup.
 */
function getManifestUrlSignature(url) {
  if (typeof url !== "string" || !url) return null
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    const stripped = url.split("#")[0].split("?")[0]
    return stripped || null
  }
}

function buildManifestSequenceIndex(segments) {
  const signatures = []
  const signatureToIndex = new Map()
  if (!Array.isArray(segments)) {
    return { signatures, signatureToIndex }
  }

  for (let index = 0; index < segments.length; index += 1) {
    const signature = getManifestUrlSignature(segments[index])
    signatures.push(signature)
    if (!signature) continue
    if (!signatureToIndex.has(signature)) {
      signatureToIndex.set(signature, index)
      continue
    }
    signatureToIndex.set(signature, -1)
  }
  return { signatures, signatureToIndex }
}

const INDEX_QUALITY_EXAMPLE_LIMIT = 5
const LOOKUP_MAPPING_EXAMPLE_LIMIT = 5

/**
 * Read-only quality report for manifest index uniqueness / ambiguity.
 * Does not alter buildManifestSequenceIndex behavior.
 */
function analyzeManifestIndexQuality(segments, signatureToIndex = null) {
  const totalSegments = Array.isArray(segments) ? segments.length : 0
  if (totalSegments === 0) {
    return {
      segments: 0,
      uniqueSignatures: 0,
      duplicateSignatures: 0,
      duplicateRatePercent: 0,
      ambiguousMappings: 0,
      resolvableSegments: 0,
      mappingCoveragePercent: 0,
      nullSignatureSegments: 0,
      firstDuplicateExamples: []
    }
  }

  const frequency = new Map()
  let nullSignatureSegments = 0
  for (const segment of segments) {
    const signature = getManifestUrlSignature(segment)
    if (!signature) {
      nullSignatureSegments += 1
      continue
    }
    frequency.set(signature, (frequency.get(signature) || 0) + 1)
  }

  const signedSegments = totalSegments - nullSignatureSegments
  const uniqueSignatures = frequency.size
  const duplicateSignatures = Math.max(0, signedSegments - uniqueSignatures)
  const duplicateRatePercent =
    signedSegments > 0 ? Math.round((duplicateSignatures / signedSegments) * 1000) / 10 : 0

  let ambiguousMappings = 0
  let resolvableSegments = 0
  const duplicateExamples = []
  for (const [signature, count] of frequency.entries()) {
    if (count > 1) {
      ambiguousMappings += 1
      duplicateExamples.push({ signature, count })
      continue
    }
    resolvableSegments += 1
  }

  if (signatureToIndex instanceof Map) {
    let indexAmbiguous = 0
    for (const mapped of signatureToIndex.values()) {
      if (mapped === -1) indexAmbiguous += 1
    }
    if (indexAmbiguous !== ambiguousMappings) {
      ambiguousMappings = indexAmbiguous
    }
  }

  duplicateExamples.sort((a, b) => b.count - a.count)
  const mappingCoveragePercent =
    totalSegments > 0
      ? Math.round((resolvableSegments / totalSegments) * 1000) / 10
      : 0

  return {
    segments: totalSegments,
    uniqueSignatures,
    duplicateSignatures,
    duplicateRatePercent,
    ambiguousMappings,
    resolvableSegments,
    mappingCoveragePercent,
    nullSignatureSegments,
    firstDuplicateExamples: duplicateExamples.slice(0, INDEX_QUALITY_EXAMPLE_LIMIT)
  }
}

function formatIndexQualityExamples(examples) {
  if (!Array.isArray(examples) || examples.length === 0) return "none"
  return examples
    .map(({ signature, count }) => {
      const label =
        typeof signature === "string" && signature.length > 72
          ? signature.slice(-72)
          : signature
      return `${label}×${count}`
    })
    .join(", ")
}

function trimLookupExample(url) {
  if (typeof url !== "string" || !url) return null
  return url.length > 72 ? url.slice(-72) : url
}

function recordManifestIndexQuality(tabId, quality, context = {}) {
  if (!quality || typeof quality !== "object") return quality
  const now = Date.now()
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity("manifestIndexQualityReports", 1)
    if (quality.mappingCoveragePercent < 100) {
      ns.bumpActivity("manifestIndexLowCoverageReports", 1)
    }
    if (quality.ambiguousMappings > 0) {
      ns.bumpActivity("manifestIndexAmbiguousMappings", quality.ambiguousMappings)
    }
  }

  const examples = formatIndexQualityExamples(quality.firstDuplicateExamples)
  const hostLabel = context.host ? ` host=${context.host}` : ""
  const message =
    `Playlist Index Quality tab=${tabId}${hostLabel} ` +
    `segments=${quality.segments} uniqueSignatures=${quality.uniqueSignatures} ` +
    `duplicateSignatures=${quality.duplicateSignatures} duplicateRate=${quality.duplicateRatePercent}% ` +
    `ambiguousMappings=${quality.ambiguousMappings} coverage=${quality.mappingCoveragePercent}% ` +
    `examples=${examples}`

  const interesting =
    quality.ambiguousMappings > 0 ||
    quality.mappingCoveragePercent < 100 ||
    quality.nullSignatureSegments > 0
  if (typeof ns.addLog === "function") {
    ns.addLog(interesting ? "INFO" : "DEBUG", message)
  }

  if (typeof state === "object" && state !== null) {
    if (!state.manifestIndexQualityByTab) {
      state.manifestIndexQualityByTab = new Map()
    }
    state.manifestIndexQualityByTab.set(tabId, { ...quality, recordedAt: now, context })
  }

  return quality
}

function getManifestIndexQualitySummary() {
  const windowTotals =
    typeof ns.sumWindowCounters === "function" ? ns.sumWindowCounters() : {}
  const reports = Math.max(
    windowTotals.manifestIndexQualityReports || 0,
    Number(state?.stats?.manifestIndexQualityReports) || 0
  )
  const lowCoverageReports = Math.max(
    windowTotals.manifestIndexLowCoverageReports || 0,
    Number(state?.stats?.manifestIndexLowCoverageReports) || 0
  )
  const ambiguousMappings = Math.max(
    windowTotals.manifestIndexAmbiguousMappings || 0,
    Number(state?.stats?.manifestIndexAmbiguousMappings) || 0
  )

  let worstCoverage = null
  let latestReport = null
  const byTab = state?.manifestIndexQualityByTab
  if (byTab instanceof Map) {
    for (const [tabId, entry] of byTab.entries()) {
      if (!entry) continue
      if (
        !worstCoverage ||
        Number(entry.mappingCoveragePercent) < Number(worstCoverage.mappingCoveragePercent)
      ) {
        worstCoverage = { tabId, ...entry }
      }
      if (!latestReport || Number(entry.recordedAt) > Number(latestReport.recordedAt)) {
        latestReport = { tabId, ...entry }
      }
    }
  }

  return {
    reports,
    lowCoverageReports,
    ambiguousMappings,
    worstCoverage,
    latestReport
  }
}

function recordLookupMappingCoverage(tabId, chunkUrl, mappedIndex, context = {}) {
  const mapped = typeof mappedIndex === "number" && mappedIndex >= 0
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity("lookupMappingChecks", 1)
    ns.bumpActivity(mapped ? "lookupMappingResolved" : "lookupMappingUnresolved", 1)
  }

  if (typeof state === "object" && state !== null && Number.isFinite(tabId)) {
    if (!state.lookupMappingCoverageByTab) {
      state.lookupMappingCoverageByTab = new Map()
    }
    const previous = state.lookupMappingCoverageByTab.get(tabId) || {
      checks: 0,
      resolved: 0,
      unresolved: 0,
      unresolvedExamples: [],
      lastCheckedAt: 0,
      lastResolvedAt: 0,
      lastUnresolvedAt: 0,
      recordedAt: 0,
      context: {}
    }

    const next = {
      ...previous,
      checks: Number(previous.checks) + 1,
      resolved: Number(previous.resolved) + (mapped ? 1 : 0),
      unresolved: Number(previous.unresolved) + (mapped ? 0 : 1),
      lastCheckedAt: Date.now(),
      recordedAt: Date.now(),
      context: { ...previous.context, ...context }
    }
    if (mapped) {
      next.lastResolvedAt = next.lastCheckedAt
    } else {
      next.lastUnresolvedAt = next.lastCheckedAt
      const example = trimLookupExample(chunkUrl)
      if (example) {
        const merged = [example, ...(Array.isArray(previous.unresolvedExamples) ? previous.unresolvedExamples : [])]
        next.unresolvedExamples = [...new Set(merged)].slice(0, LOOKUP_MAPPING_EXAMPLE_LIMIT)
      }
    }
    next.coveragePercent =
      next.checks > 0 ? Math.round((next.resolved / next.checks) * 1000) / 10 : null
    state.lookupMappingCoverageByTab.set(tabId, next)
  }

  return {
    mapped,
    mappedIndex: mapped ? mappedIndex : null
  }
}

function getLookupMappingCoverageSummary() {
  const windowTotals =
    typeof ns.sumWindowCounters === "function" ? ns.sumWindowCounters() : {}
  const checks = Math.max(
    windowTotals.lookupMappingChecks || 0,
    Number(state?.stats?.lookupMappingChecks) || 0
  )
  const resolved = Math.max(
    windowTotals.lookupMappingResolved || 0,
    Number(state?.stats?.lookupMappingResolved) || 0
  )
  const unresolved = Math.max(
    windowTotals.lookupMappingUnresolved || 0,
    Number(state?.stats?.lookupMappingUnresolved) || 0
  )
  const observedTotal = checks > 0 ? checks : resolved + unresolved
  const coveragePercent =
    observedTotal > 0 ? Math.round((resolved / observedTotal) * 1000) / 10 : null

  let worstCoverage = null
  let latestReport = null
  const byTab = state?.lookupMappingCoverageByTab
  if (byTab instanceof Map) {
    for (const [tabId, entry] of byTab.entries()) {
      if (!entry) continue
      if (
        !worstCoverage ||
        Number(entry.coveragePercent) < Number(worstCoverage.coveragePercent)
      ) {
        worstCoverage = { tabId, ...entry }
      }
      if (!latestReport || Number(entry.recordedAt) > Number(latestReport.recordedAt)) {
        latestReport = { tabId, ...entry }
      }
    }
  }

  return {
    checks,
    resolved,
    unresolved,
    coveragePercent,
    worstCoverage,
    latestReport
  }
}

function resolveSegmentIndexInManifest(chunkUrl, tabState) {
  if (!tabState?.signatureToIndex || !tabState?.segments?.length) return null
  const signature = getManifestUrlSignature(chunkUrl)
  if (!signature) return null

  const mapped = tabState.signatureToIndex.get(signature)
  if (mapped === -1) return null
  if (typeof mapped === "number" && mapped >= 0) return mapped

  const signatures = tabState.manifestSignatures
  if (Array.isArray(signatures)) {
    const idx = signatures.indexOf(signature)
    if (idx >= 0) {
      const second = signatures.indexOf(signature, idx + 1)
      if (second < 0) return idx
    }
  }
  return null
}

function getSequentialPrefetchTargets(segments, anchorIndex, windowSize) {
  if (!Array.isArray(segments) || segments.length === 0) return []
  if (typeof anchorIndex !== "number" || anchorIndex < 0) return []
  const size = Math.max(1, Number(windowSize) || 1)
  const start = anchorIndex + 1
  if (start >= segments.length) return []
  return segments.slice(start, start + size)
}

const PAGE_FINGERPRINT_QUERY_KEYS = [
  "id",
  "v",
  "video",
  "episode",
  "e",
  "clip",
  "contentId",
  "content_id",
  "vid"
]

function appendPageFingerprintQuery(fingerprint, searchParams) {
  if (!searchParams || typeof searchParams.get !== "function") return fingerprint
  const parts = []
  for (const key of PAGE_FINGERPRINT_QUERY_KEYS) {
    const value = searchParams.get(key)
    if (value != null && value !== "") parts.push(`${key}=${value}`)
  }
  if (!parts.length) return fingerprint
  return `${fingerprint}?${parts.sort().join("&")}`
}

/** Stable page identity for episode navigation (pathname + content-related query keys). */
function getPageUrlFingerprint(pageUrl) {
  if (typeof pageUrl !== "string" || !pageUrl) return null
  try {
    const parsed = new URL(pageUrl)
    const base = `${parsed.origin}${parsed.pathname}`
    return appendPageFingerprintQuery(base, parsed.searchParams)
  } catch {
    const stripped = pageUrl.split("#")[0]
    const queryIndex = stripped.indexOf("?")
    const base = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped
    if (queryIndex < 0) return base || null
    try {
      const params = new URLSearchParams(stripped.slice(queryIndex + 1))
      return appendPageFingerprintQuery(base, params) || null
    } catch {
      return base || null
    }
  }
}

function roundDurationSeconds(totalDuration) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) return null
  return Math.round(totalDuration * 1000) / 1000
}

function fnv1aHashHex(payload) {
  if (typeof payload !== "string" || !payload.length) return "0"
  let hash = 2166136261
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function roundDurationMs(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.round(duration * 1000)
}

function getRelativePathTail(url) {
  const signature = getManifestUrlSignature(url)
  if (!signature) return ""
  const parts = signature.split("/").filter(Boolean)
  if (parts.length <= 2) return parts.join("/")
  return parts.slice(-2).join("/")
}

function buildRelativePathProfile(segments, maxHead = 16, maxTail = 6) {
  const list = Array.isArray(segments) ? segments : []
  if (list.length === 0) return ""
  const head = list.slice(0, maxHead).map(getRelativePathTail)
  const tail = list.length > maxHead + maxTail ? list.slice(-maxTail).map(getRelativePathTail) : []
  return `${head.join(";")}|${tail.join(";")}`
}

function buildDiscontinuityProfile(markers) {
  if (!Array.isArray(markers) || markers.length === 0) return ""
  let count = 0
  const slots = []
  for (let i = 0; i < markers.length; i += 1) {
    if (markers[i] === 1) {
      count += 1
      if (slots.length < 12) slots.push(i)
    }
  }
  return `${count}:${slots.join(",")}`
}

/**
 * Timeline anatomy only: counts, durations, relative path tails, discontinuity slots.
 * Ignores playlist comments, CDN hosts, and signed query tokens.
 */
/**
 * Timeline fingerprint from segment durations only (ignores signed URLs and paths).
 */
function buildDurationGeometryHash(segmentDurations, segmentCount) {
  const durations = Array.isArray(segmentDurations) ? segmentDurations : []
  const count = Number.isFinite(segmentCount) ? segmentCount : durations.length
  if (count <= 0 && durations.length === 0) return null
  const parts = []
  const limit = count > 0 ? Math.min(count, durations.length) : durations.length
  for (let i = 0; i < limit; i += 1) {
    parts.push(roundDurationMs(durations[i]))
  }
  if (!parts.length) return fnv1aHashHex(`count:${count}`)
  return fnv1aHashHex(`${count}|${parts.join(",")}`)
}

function buildStructuralPlaylistHash({
  segmentDurations,
  segments,
  discontinuityMarkers,
  isLive,
  segmentCount
}) {
  const durations = Array.isArray(segmentDurations) ? segmentDurations : []
  const count = Number.isFinite(segmentCount) ? segmentCount : durations.length
  const head = durations.slice(0, 24).map(roundDurationMs)
  const tail = count > 12 ? durations.slice(-6).map(roundDurationMs) : []
  const pathProfile = buildRelativePathProfile(segments)
  const discontinuityProfile = buildDiscontinuityProfile(discontinuityMarkers)
  const payload = [
    count,
    isLive === true ? "live" : "vod",
    head.join(","),
    tail.join(","),
    pathProfile,
    discontinuityProfile
  ].join("|")
  return fnv1aHashHex(payload)
}

function estimateManifestIndexFromTime(currentTimeSec, segmentDurations, options = {}) {
  const time = Number(currentTimeSec)
  if (!Number.isFinite(time) || time < 0) return null
  const durations = Array.isArray(segmentDurations) ? segmentDurations : []
  const fallback = Number(options.fallbackSegmentDurationSec) || 4

  if (durations.length > 0) {
    let elapsed = 0
    for (let index = 0; index < durations.length; index += 1) {
      const raw = durations[index]
      const segmentDuration =
        Number.isFinite(raw) && raw > 0 ? raw : fallback
      if (time < elapsed + segmentDuration) return index
      elapsed += segmentDuration
    }
    return Math.max(0, durations.length - 1)
  }

  const totalDuration = Number(options.totalDurationSec)
  const segmentCount = Number(options.segmentCount)
  if (Number.isFinite(totalDuration) && totalDuration > 0 && Number.isFinite(segmentCount) && segmentCount > 0) {
    const ratio = Math.min(1, time / totalDuration)
    return Math.min(segmentCount - 1, Math.max(0, Math.floor(ratio * segmentCount)))
  }

  return null
}

function buildPlaylistFingerprint({
  segments,
  mediaPlaylistPath,
  mediaSequence,
  totalDuration,
  pageUrl
}) {
  const list = Array.isArray(segments) ? segments : []
  const first = list[0]
  const last = list[list.length - 1]
  return {
    mediaPlaylistPath: mediaPlaylistPath || null,
    segmentCount: list.length,
    firstSegmentSignature: first ? getManifestUrlSignature(first) : null,
    lastSegmentSignature: last ? getManifestUrlSignature(last) : null,
    mediaSequence: Number.isFinite(mediaSequence) ? mediaSequence : null,
    totalDuration: roundDurationSeconds(totalDuration),
    pageUrlHash: getPageUrlFingerprint(pageUrl)
  }
}

const PLAYLIST_FINGERPRINT_SCORE = {
  pageUrl: 50,
  duration: 20,
  segmentEndpoints: 20,
  mediaPlaylist: 20,
  segmentCount: 10
}
const NEW_PLAYBACK_SCORE_THRESHOLD = 45

function formatFingerprintReason(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return null
  return signals.join(" + ")
}

/**
 * Confidence-weighted playlist change assessment. Weak signals alone stay below
 * threshold; page navigation or multiple corroborating signals indicate new playback.
 */
function scorePlaylistFingerprintChange(previous, current, options = {}) {
  const threshold = NEW_PLAYBACK_SCORE_THRESHOLD
  if (!previous || !current) {
    return {
      contentChanged: false,
      score: 0,
      threshold,
      signals: [],
      fingerprintReason: null,
      pageChanged: false,
      durationChanged: false,
      endpointsChanged: false,
      mediaPlaylistChanged: false,
      segmentCountChanged: false
    }
  }

  const signals = []
  let score = 0

  const pageChanged =
    Boolean(previous.pageUrlHash && current.pageUrlHash) &&
    previous.pageUrlHash !== current.pageUrlHash
  if (pageChanged) {
    score += PLAYLIST_FINGERPRINT_SCORE.pageUrl
    signals.push("page-url")
  }

  const durationChanged =
    previous.totalDuration != null &&
    current.totalDuration != null &&
    previous.totalDuration !== current.totalDuration
  if (durationChanged) {
    score += PLAYLIST_FINGERPRINT_SCORE.duration
    signals.push("duration")
  }

  const firstChanged = previous.firstSegmentSignature !== current.firstSegmentSignature
  const lastChanged = previous.lastSegmentSignature !== current.lastSegmentSignature
  const endpointsChanged = firstChanged || lastChanged
  if (endpointsChanged) {
    score += PLAYLIST_FINGERPRINT_SCORE.segmentEndpoints
    if (firstChanged && lastChanged) {
      signals.push("segment-endpoints")
    } else if (firstChanged) {
      signals.push("first-segment")
    } else {
      signals.push("last-segment")
    }
  }

  const mediaPlaylistChanged =
    Boolean(previous.mediaPlaylistPath && current.mediaPlaylistPath) &&
    previous.mediaPlaylistPath !== current.mediaPlaylistPath
  if (mediaPlaylistChanged) {
    score += PLAYLIST_FINGERPRINT_SCORE.mediaPlaylist
    signals.push("media-playlist")
  }

  const segmentCountChanged =
    Number.isFinite(previous.segmentCount) &&
    Number.isFinite(current.segmentCount) &&
    previous.segmentCount !== current.segmentCount
  if (segmentCountChanged && !options.isLive) {
    score += PLAYLIST_FINGERPRINT_SCORE.segmentCount
    signals.push("segment-count")
  }

  const fingerprintReason = formatFingerprintReason(signals)
  const contentChanged = score >= threshold

  return {
    contentChanged,
    score,
    threshold,
    signals,
    fingerprintReason,
    pageChanged,
    durationChanged,
    endpointsChanged,
    mediaPlaylistChanged,
    segmentCountChanged
  }
}

function comparePlaylistFingerprints(previous, current, options = {}) {
  return scorePlaylistFingerprintChange(previous, current, options)
}

ns.getManifestUrlSignature = getManifestUrlSignature
ns.buildManifestSequenceIndex = buildManifestSequenceIndex
ns.analyzeManifestIndexQuality = analyzeManifestIndexQuality
ns.recordManifestIndexQuality = recordManifestIndexQuality
ns.getManifestIndexQualitySummary = getManifestIndexQualitySummary
ns.recordLookupMappingCoverage = recordLookupMappingCoverage
ns.getLookupMappingCoverageSummary = getLookupMappingCoverageSummary
ns.resolveSegmentIndexInManifest = resolveSegmentIndexInManifest
ns.getSequentialPrefetchTargets = getSequentialPrefetchTargets
ns.getPageUrlFingerprint = getPageUrlFingerprint
ns.getRelativePathTail = getRelativePathTail
ns.buildStructuralPlaylistHash = buildStructuralPlaylistHash
ns.buildDurationGeometryHash = buildDurationGeometryHash
ns.estimateManifestIndexFromTime = estimateManifestIndexFromTime
ns.buildPlaylistFingerprint = buildPlaylistFingerprint
ns.scorePlaylistFingerprintChange = scorePlaylistFingerprintChange
ns.comparePlaylistFingerprints = comparePlaylistFingerprints
ns.PLAYLIST_FINGERPRINT_SCORE = PLAYLIST_FINGERPRINT_SCORE
ns.NEW_PLAYBACK_SCORE_THRESHOLD = NEW_PLAYBACK_SCORE_THRESHOLD
})()
