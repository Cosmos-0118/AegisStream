/**
 * Page-world invariant cache key helpers (MAIN world).
 */
(() => {
  const ns = (globalThis.AegisPageBridge ||= {})

  const HLS_EXT =
    /\.(ts|m4s|mp4|cmf|webm|aac|m4a|m4v|fmp4|cmfv|cmfa|cmft)($|[?#])/i
  const OBFUSCATED_BLOB_RE = /^[A-Za-z0-9+/_=-]+$/
  const AEGIS_BYTES_HASH_RE = /#aegis-bytes=(\d+)-(\d+)\s*$/i

  function stripHash(url) {
    if (typeof url !== "string") return null
    return url.split("#")[0]
  }

  function parseAegisByteRangeRef(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return null
    const match = rawUrl.match(AEGIS_BYTES_HASH_RE)
    if (!match) return null
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    const base = stripHash(rawUrl)
    if (!base) return null
    return { url: base, start, end }
  }

  function formatAegisByteRangeRef(url, start, end) {
    const base = stripHash(url)
    if (!base || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    return `${base}#aegis-bytes=${Math.trunc(start)}-${Math.trunc(end)}`
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
        // Bare host/path keys must not inherit the page origin as hostname.
        const hostPathMatch = normalized.match(/^([a-z0-9.-]+\.[a-z]{2,})(\/[^?#]*)/i)
        if (hostPathMatch) {
          parsed = new URL(`https://${hostPathMatch[1]}${hostPathMatch[2]}`)
        } else {
          const base =
            typeof location !== "undefined" && location.href ? location.href : "https://localhost/"
          parsed = new URL(normalized, base)
        }
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

  function buildByteRangeCacheKey(rawUrl, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    const base = stripHash(rawUrl)
    if (!base) return null
    const invariant = buildMediaInvariantKey(base)
    let streamId = invariant
    if (!streamId) {
      try {
        const parsed = new URL(base, typeof location !== "undefined" ? location.href : undefined)
        streamId = `${parsed.hostname}${parsed.pathname}`
      } catch {
        streamId = base
      }
    }
    return `range|${streamId}|${Math.trunc(start)}-${Math.trunc(end)}`
  }

  function resolveByteRangeCacheKey(rawUrl, rangeHeader = null) {
    const fromRef = parseAegisByteRangeRef(rawUrl)
    if (fromRef) return buildByteRangeCacheKey(fromRef.url, fromRef.start, fromRef.end)
    if (typeof rawUrl === "string" && rawUrl.startsWith("range|")) return rawUrl
    if (typeof rangeHeader === "string" && rangeHeader) {
      const match = rangeHeader.match(/bytes\s*=\s*(\d+)\s*-\s*(\d+)/i)
      if (match) {
        return buildByteRangeCacheKey(rawUrl, Number(match[1]), Number(match[2]))
      }
    }
    return null
  }

  function resolvePrefetchCoalesceKey(rawUrl) {
    const rangeKey = resolveByteRangeCacheKey(rawUrl)
    if (rangeKey) return rangeKey
    const normalized = stripHash(rawUrl)
    if (!normalized) return null
    if (typeof normalized === "string" && /^(?:range|aegis)\|/.test(normalized)) return normalized
    const invariant = buildMediaInvariantKey(normalized)
    return invariant || normalized
  }

  ns.stripHash = ns.stripHash || stripHash
  ns.buildMediaInvariantKey = buildMediaInvariantKey
  ns.parseAegisByteRangeRef = parseAegisByteRangeRef
  ns.formatAegisByteRangeRef = formatAegisByteRangeRef
  ns.buildByteRangeCacheKey = buildByteRangeCacheKey
  ns.resolveByteRangeCacheKey = resolveByteRangeCacheKey
  ns.resolvePrefetchCoalesceKey = resolvePrefetchCoalesceKey
})()
