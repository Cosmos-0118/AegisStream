(() => {
var ns = (self.AegisBackground ||= {})
const { stripHash, getManifestUrlSignature } = ns

function labelFromVariantMeta(meta, index) {
  if (meta?.resolution) return String(meta.resolution)
  const bw = Number(meta?.bandwidth)
  if (Number.isFinite(bw) && bw > 0) {
    if (bw >= 1_000_000) return `${Math.round(bw / 1_000_000)}M`
    return `${Math.round(bw / 1000)}k`
  }
  return `rung-${index + 1}`
}

function sortRungsByBandwidth(rungs) {
  return [...rungs].sort((a, b) => Number(a.bandwidth || 0) - Number(b.bandwidth || 0))
}

/**
 * Build a timeline-indexed matrix: rows[i][rungLabel] = segment URL at index i.
 * Aligns VOD renditions by segment index (minimum shared length).
 */
function buildPlaylistMatrix(rungs) {
  const sorted = sortRungsByBandwidth(
    (Array.isArray(rungs) ? rungs : []).filter((r) => Array.isArray(r.segments) && r.segments.length > 0)
  )
  if (sorted.length === 0) {
    return {
      rows: [],
      rungLabels: [],
      rungByLabel: {},
      mediaUrlToRung: {},
      segmentCount: 0,
      builtAt: Date.now()
    }
  }

  let alignedLength = sorted[0].segments.length
  for (const rung of sorted) {
    alignedLength = Math.min(alignedLength, rung.segments.length)
  }
  alignedLength = Math.max(0, alignedLength)

  const rungLabels = []
  const rungByLabel = {}
  const mediaUrlToRung = {}
  const rows = []

  for (const rung of sorted) {
    const label = rung.label || labelFromVariantMeta(rung, rungLabels.length)
    if (rungByLabel[label]) continue
    rungLabels.push(label)
    rungByLabel[label] = {
      label,
      bandwidth: Number(rung.bandwidth) || 0,
      resolution: rung.resolution || null,
      mediaPlaylistUrl: stripHash(rung.mediaPlaylistUrl) || null,
      segmentCount: rung.segments.length
    }
    if (rungByLabel[label].mediaPlaylistUrl) {
      mediaUrlToRung[rungByLabel[label].mediaPlaylistUrl] = label
      const pathSig = getManifestUrlSignature(rungByLabel[label].mediaPlaylistUrl)
      if (pathSig) mediaUrlToRung[pathSig] = label
    }
  }

  for (let index = 0; index < alignedLength; index += 1) {
    const row = {}
    for (const rung of sorted) {
      const label = rung.label || labelFromVariantMeta(rung, 0)
      if (!rungByLabel[label]) continue
      const url = stripHash(rung.segments[index])
      if (url) row[label] = url
    }
    if (Object.keys(row).length > 0) rows.push(row)
  }

  return {
    rows,
    rungLabels,
    rungByLabel,
    mediaUrlToRung,
    segmentCount: rows.length,
    builtAt: Date.now()
  }
}

function resolveRungLabelForMediaUrl(matrix, mediaPlaylistUrl) {
  if (!matrix || !mediaPlaylistUrl) return null
  const normalized = stripHash(mediaPlaylistUrl)
  if (!normalized) return null
  if (matrix.mediaUrlToRung[normalized]) return matrix.mediaUrlToRung[normalized]
  const sig = getManifestUrlSignature(normalized)
  if (sig && matrix.mediaUrlToRung[sig]) return matrix.mediaUrlToRung[sig]
  return null
}

function getAdjacentRungLabels(matrix, activeLabel) {
  if (!matrix?.rungLabels?.length || !activeLabel) return []
  const labels = matrix.rungLabels
  const idx = labels.indexOf(activeLabel)
  if (idx < 0) return labels.filter((l) => l !== activeLabel)
  const out = []
  if (idx > 0) out.push(labels[idx - 1])
  if (idx < labels.length - 1) out.push(labels[idx + 1])
  return out
}

function getMatrixSegmentUrl(matrix, segmentIndex, rungLabel) {
  if (!matrix?.rows?.length || !rungLabel) return null
  if (segmentIndex < 0 || segmentIndex >= matrix.rows.length) return null
  return matrix.rows[segmentIndex][rungLabel] || null
}

function resolveMatrixAnchorIndex(matrix, previousAnchorIndex, nextSegmentCount) {
  if (!matrix?.rows?.length) return null
  if (typeof previousAnchorIndex !== "number" || previousAnchorIndex < 0) return null
  const maxIndex = Math.min(
    matrix.rows.length - 1,
    Math.max(0, Number(nextSegmentCount) || 0) - 1
  )
  return Math.min(previousAnchorIndex, maxIndex)
}

ns.labelFromVariantMeta = labelFromVariantMeta
ns.buildPlaylistMatrix = buildPlaylistMatrix
ns.resolveRungLabelForMediaUrl = resolveRungLabelForMediaUrl
ns.getAdjacentRungLabels = getAdjacentRungLabels
ns.getMatrixSegmentUrl = getMatrixSegmentUrl
ns.resolveMatrixAnchorIndex = resolveMatrixAnchorIndex
})()
