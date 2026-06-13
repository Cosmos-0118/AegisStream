/**
 * Page-world invariant cache key helpers (MAIN world).
 */
(() => {
  const ns = (globalThis.AegisPageBridge ||= {})

  const HLS_EXT =
    /\.(ts|m4s|mp4|cmf|webm|aac|m4a|m4v|fmp4|cmfv|cmfa|cmft)($|[?#])/i
  const OBFUSCATED_BLOB_RE = /^[A-Za-z0-9+/_=-]+$/

  function stripHash(url) {
    if (typeof url !== "string") return null
    return url.split("#")[0]
  }

  function isObfuscatedBlobSegment(segment) {
    if (typeof segment !== "string" || segment.length < 40) return false
    if (HLS_EXT.test(segment)) return false
    if (segment.includes(".")) return false
    return OBFUSCATED_BLOB_RE.test(segment)
  }

  function extractInvariantBlobTail(segment) {
    if (typeof segment !== "string" || !segment) return null
    const tailLen = Math.min(segment.length, 56)
    return segment.slice(-tailLen)
  }

  function buildMediaInvariantKey(rawUrl) {
    const normalized = stripHash(rawUrl)
    if (!normalized) return null

    try {
      let parsed
      try {
        parsed = new URL(normalized)
      } catch {
        const base =
          typeof location !== "undefined" && location.href ? location.href : "https://localhost/"
        parsed = new URL(normalized, base)
      }
      const host = parsed.hostname.toLowerCase()
      const segments = parsed.pathname.split("/").filter(Boolean)
      if (!segments.length) return null

      const last = segments[segments.length - 1]
      if (last && HLS_EXT.test(last)) {
        const tail = segments.slice(-2).join("/")
        return tail ? `aegis|hls|${host}|${tail}` : null
      }

      if (isObfuscatedBlobSegment(last)) {
        const fingerprint = extractInvariantBlobTail(last)
        return fingerprint ? `aegis|blob|${host}|${fingerprint}` : null
      }

      if (segments.length === 1 && isObfuscatedBlobSegment(segments[0])) {
        const fingerprint = extractInvariantBlobTail(segments[0])
        return fingerprint ? `aegis|blob|${host}|${fingerprint}` : null
      }
    } catch {
      const stripped = normalized.split(/[?#]/)[0]
      const part = stripped.split("/").filter(Boolean).pop()
      if (part && isObfuscatedBlobSegment(part)) {
        const fingerprint = extractInvariantBlobTail(part)
        return fingerprint ? `aegis|fallback|${fingerprint}` : null
      }
    }
    return null
  }

  ns.stripHash = ns.stripHash || stripHash
  ns.buildMediaInvariantKey = buildMediaInvariantKey
})()
