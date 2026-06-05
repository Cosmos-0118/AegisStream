/**
 * Shared media cache identity — used by background cache-keys (importScripts).
 * Decouples IndexedDB keys from volatile CDN path prefixes / session rotators.
 */
(() => {
  var ns = (self.AegisBackground ||= {})

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
    return typeof value === "string" && /^(?:range|aegis|ump)\|/.test(value)
  }

  /**
   * Stable identity for prefetch/collapse — ignores volatile query tokens when possible.
   */
  function resolvePrefetchCoalesceKey(rawUrl) {
    const normalized = stripHash(rawUrl)
    if (!normalized) return null
    if (isCanonicalCoalesceKey(normalized)) return normalized
    const invariant = buildMediaInvariantKey(normalized)
    return invariant || normalized
  }

  /** Canonical registry key — must match page cache-registry resolveRegistryKey contract. */
  function resolveRegistryKey(url) {
    if (!url || typeof url !== "string") return null
    if (url.startsWith("ump|") || url.startsWith("range|")) return url
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
})()
