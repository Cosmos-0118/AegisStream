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

ns.getManifestUrlSignature = getManifestUrlSignature
ns.buildManifestSequenceIndex = buildManifestSequenceIndex
ns.resolveSegmentIndexInManifest = resolveSegmentIndexInManifest
ns.getSequentialPrefetchTargets = getSequentialPrefetchTargets
})()
