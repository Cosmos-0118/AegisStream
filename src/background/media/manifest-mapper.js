(() => {
var ns = (self.AegisBackground ||= {})

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
ns.resolveSegmentIndexInManifest = resolveSegmentIndexInManifest
ns.getSequentialPrefetchTargets = getSequentialPrefetchTargets
ns.getPageUrlFingerprint = getPageUrlFingerprint
ns.buildPlaylistFingerprint = buildPlaylistFingerprint
ns.scorePlaylistFingerprintChange = scorePlaylistFingerprintChange
ns.comparePlaylistFingerprints = comparePlaylistFingerprints
ns.PLAYLIST_FINGERPRINT_SCORE = PLAYLIST_FINGERPRINT_SCORE
ns.NEW_PLAYBACK_SCORE_THRESHOLD = NEW_PLAYBACK_SCORE_THRESHOLD
})()
