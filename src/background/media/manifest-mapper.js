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

function comparePlaylistFingerprints(previous, current) {
  if (!previous || !current) {
    return {
      contentChanged: false,
      pageChanged: false,
      durationChanged: false,
      endpointsChanged: false,
      mediaPlaylistChanged: false
    }
  }
  const pageChanged =
    Boolean(previous.pageUrlHash && current.pageUrlHash) &&
    previous.pageUrlHash !== current.pageUrlHash
  const durationChanged =
    previous.totalDuration != null &&
    current.totalDuration != null &&
    previous.totalDuration !== current.totalDuration
  const endpointsChanged =
    previous.firstSegmentSignature !== current.firstSegmentSignature ||
    previous.lastSegmentSignature !== current.lastSegmentSignature
  const mediaPlaylistChanged =
    Boolean(previous.mediaPlaylistPath && current.mediaPlaylistPath) &&
    previous.mediaPlaylistPath !== current.mediaPlaylistPath
  const contentChanged =
    pageChanged || durationChanged || endpointsChanged || mediaPlaylistChanged
  return {
    contentChanged,
    pageChanged,
    durationChanged,
    endpointsChanged,
    mediaPlaylistChanged
  }
}

ns.getManifestUrlSignature = getManifestUrlSignature
ns.buildManifestSequenceIndex = buildManifestSequenceIndex
ns.resolveSegmentIndexInManifest = resolveSegmentIndexInManifest
ns.getSequentialPrefetchTargets = getSequentialPrefetchTargets
ns.getPageUrlFingerprint = getPageUrlFingerprint
ns.buildPlaylistFingerprint = buildPlaylistFingerprint
ns.comparePlaylistFingerprints = comparePlaylistFingerprints
})()
