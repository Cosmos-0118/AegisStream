/**
 * Shared media cache identity — used by background cache-keys (importScripts).
 * Decouples IndexedDB keys from volatile CDN path prefixes / session rotators.
 */
(() => {
  var ns = (self.AegisBackground ||= {})

  const HLS_EXT =
    /\.(ts|m4s|mp4|cmf|webm|aac|m4a|m4v|fmp4|cmfv|cmfa|cmft)($|[?#])/i
  const OBFUSCATED_BLOB_RE = /^[A-Za-z0-9+/_=-]+$/

  const AEGIS_BYTES_HASH_RE = /#aegis-bytes=(\d+)-(\d+)\s*$/i

  function stripHash(url) {
    if (typeof url !== "string") return null
    return url.split("#")[0]
  }

  /** Peel `#aegis-bytes=start-end` segment refs used for HLS BYTERANGE playlists. */
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

  function parseRangeCacheKey(cacheKey) {
    if (typeof cacheKey !== "string" || !cacheKey.startsWith("range|")) return null
    const lastPipe = cacheKey.lastIndexOf("|")
    if (lastPipe <= 6) return null
    const rangePart = cacheKey.slice(lastPipe + 1)
    const match = rangePart.match(/^(\d+)-(\d+)$/)
    if (!match) return null
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    return { start, end, streamId: cacheKey.slice(6, lastPipe) }
  }

  /**
   * Stable cache identity for one HLS BYTERANGE slice.
   * Prefetch/store/lookup all use this key; the network fetch uses the base URL + Range.
   */
  function buildByteRangeCacheKey(rawUrl, start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
    const base = stripHash(rawUrl)
    if (!base) return null
    const invariant = buildMediaInvariantKey(base)
    let streamId = invariant
    if (!streamId) {
      try {
        const parsed = new URL(base)
        streamId = `${parsed.hostname}${parsed.pathname}`
      } catch {
        streamId = base
      }
    }
    return `range|${streamId}|${Math.trunc(start)}-${Math.trunc(end)}`
  }

  /** Preserve BYTERANGE segment identity while normalizing ordinary URLs. */
  function normalizeSegmentRef(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return null
    const ranged = parseAegisByteRangeRef(rawUrl)
    if (ranged) {
      return formatAegisByteRangeRef(ranged.url, ranged.start, ranged.end)
    }
    if (rawUrl.startsWith("range|")) return rawUrl
    return stripHash(rawUrl)
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

  function isObfuscatedBlobSegment(segment) {
    if (typeof segment !== "string" || segment.length < 40) return false
    if (HLS_EXT.test(segment)) return false
    if (segment.includes(".")) return false
    return OBFUSCATED_BLOB_RE.test(segment)
  }

  function extractInvariantBlobTail(segment) {
    if (typeof segment !== "string" || !segment) return null
    const configured = Number(ns.constants?.MEDIA_CACHE_INVARIANT_TAIL_LEN)
    const tailLen =
      Number.isFinite(configured) && configured > 16
        ? Math.min(segment.length, configured)
        : Math.min(segment.length, Math.max(40, Math.floor(segment.length * 0.55)))
    return segment.slice(-tailLen)
  }

  function buildMediaInvariantKey(rawUrl) {
    const normalized = stripHash(rawUrl)
    if (!normalized) return null

    try {
      const parsed = new URL(normalized)
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

  function isCanonicalCoalesceKey(value) {
    return typeof value === "string" && /^(?:range|aegis)\|/.test(value)
  }

  /**
   * Stable identity for prefetch/collapse — ignores volatile query tokens when possible.
   */
  function resolvePrefetchCoalesceKey(rawUrl) {
    const rangeKey = resolveByteRangeCacheKey(rawUrl)
    if (rangeKey) return rangeKey
    const normalized = stripHash(rawUrl)
    if (!normalized) return null
    if (isCanonicalCoalesceKey(normalized)) return normalized
    const invariant = buildMediaInvariantKey(normalized)
    return invariant || normalized
  }

  /** Canonical registry key — must match page cache-registry resolveRegistryKey contract. */
  function resolveRegistryKey(url) {
    if (!url || typeof url !== "string") return null
    const rangeKey = resolveByteRangeCacheKey(url)
    if (rangeKey) return rangeKey
    if (url.startsWith("range|")) return url
    const invariant = buildMediaInvariantKey(url)
    if (invariant) return invariant
    return stripHash(url)
  }

  ns.buildMediaInvariantKey = buildMediaInvariantKey
  ns.resolveRegistryKey = resolveRegistryKey
  ns.isObfuscatedBlobSegment = isObfuscatedBlobSegment
  ns.extractInvariantBlobTail = extractInvariantBlobTail
  ns.isCanonicalCoalesceKey = isCanonicalCoalesceKey
  ns.resolvePrefetchCoalesceKey = resolvePrefetchCoalesceKey
  ns.parseAegisByteRangeRef = parseAegisByteRangeRef
  ns.formatAegisByteRangeRef = formatAegisByteRangeRef
  ns.buildByteRangeCacheKey = buildByteRangeCacheKey
  ns.parseRangeCacheKey = parseRangeCacheKey
  ns.normalizeSegmentRef = normalizeSegmentRef
  ns.resolveByteRangeCacheKey = resolveByteRangeCacheKey
})()
