(() => {
var ns = (self.AegisBackground ||= {})
const { constants, addLog } = ns

function stripHash(url) {
  if (typeof url !== "string") return null
  return url.split("#")[0]
}

function toAbsoluteUrl(baseUrl, candidate) {
  try {
    return stripHash(new URL(candidate, baseUrl).toString())
  } catch {
    return null
  }
}

function isRangeCacheKey(url) {
  return typeof url === "string" && url.startsWith("range|")
}

function sortedParamsUrl(urlObj, shouldKeepParam = () => true) {
  const entries = []
  for (const [key, value] of urlObj.searchParams.entries()) {
    if (!shouldKeepParam(key, value)) continue
    entries.push([key, value])
  }
  entries.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey !== bKey) return aKey.localeCompare(bKey)
    return aValue.localeCompare(bValue)
  })

  const out = new URL(urlObj.toString())
  out.search = ""
  for (const [key, value] of entries) {
    out.searchParams.append(key, value)
  }
  return stripHash(out.toString())
}

function hasIdentityQuery(urlObj) {
  for (const key of urlObj.searchParams.keys()) {
    if (constants.IDENTITY_QUERY_PARAMS.has(key.toLowerCase())) return true
  }
  return false
}

function hasOnlyIdentityQuery(urlObj) {
  let hasIdentity = false
  for (const key of urlObj.searchParams.keys()) {
    const normalized = key.toLowerCase()
    if (constants.IDENTITY_QUERY_PARAMS.has(normalized)) {
      hasIdentity = true
      continue
    }
    return false
  }
  return hasIdentity
}

function buildCacheKeyVariants(rawUrl) {
  const normalizedUrl = stripHash(rawUrl)
  if (!normalizedUrl) return []
  if (isRangeCacheKey(normalizedUrl)) return [normalizedUrl]
  if (isUmpCacheKey(normalizedUrl)) {
    const variants = [normalizedUrl]
    const bodyHash = getUmpBodyHashFromCacheKey(normalizedUrl)
    if (bodyHash) {
      const hashOnly = `ump|${bodyHash}`
      if (hashOnly !== normalizedUrl) variants.push(hashOnly)
    }
    return variants.slice(0, constants.MAX_CACHE_KEY_VARIANTS)
  }

  const variants = []
  const seen = new Set()
  const pushVariant = (value) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    variants.push(value)
  }
  pushVariant(normalizedUrl)

  try {
    const parsed = new URL(normalizedUrl)
    if (parsed.search) {
      pushVariant(sortedParamsUrl(parsed))
      pushVariant(
        sortedParamsUrl(parsed, (key) => !constants.VOLATILE_QUERY_PARAMS.has(key.toLowerCase()))
      )
      if (hasIdentityQuery(parsed)) {
        pushVariant(
          sortedParamsUrl(parsed, (key) => constants.IDENTITY_QUERY_PARAMS.has(key.toLowerCase()))
        )
      }
      if (!hasIdentityQuery(parsed) || hasOnlyIdentityQuery(parsed)) {
        pushVariant(`${parsed.origin}${parsed.pathname}`)
      }
    }
  } catch {
    // Non-URL cache keys remain valid exact keys.
  }
  return variants.slice(0, constants.MAX_CACHE_KEY_VARIANTS)
}

function isUmpCacheKey(url) {
  return typeof url === "string" && url.startsWith("ump|")
}

function getUmpBodyHashFromCacheKey(cacheKey) {
  if (!isUmpCacheKey(cacheKey)) return null
  const lastPipe = cacheKey.lastIndexOf("|")
  if (lastPipe < 4 || lastPipe >= cacheKey.length - 1) return null
  const bodyHash = cacheKey.slice(lastPipe + 1)
  return /^[0-9a-f]{8,64}$/i.test(bodyHash) ? bodyHash : null
}

function arrayBufferToBase64(buffer) {
  if (!buffer || typeof buffer.byteLength !== "number") return null
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64) {
  if (typeof base64 !== "string" || base64.length === 0) return null
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function extractMessageBytes(message) {
  if (message?.bytes && typeof message.bytes.byteLength === "number") {
    return message.bytes
  }
  if (typeof message?.bytesBase64 === "string") {
    try {
      return base64ToArrayBuffer(message.bytesBase64)
    } catch {
      return null
    }
  }
  return null
}

function isPlaylistUrl(url) {
  if (!url) return false
  if (/\.m3u8($|\?)/i.test(url)) return true
  if (/\.mpd($|\?)/i.test(url)) return true
  if (/\/manifest\b/i.test(url) && /format=m3u8|hls|dash/i.test(url)) return true
  if (/[?&]format=mpd/i.test(url)) return true
  return false
}

function isLikelyChunkUrl(url) {
  if (!url) return false
  if (/\.(ts|m4s|mp4|cmf|webm|aac|m4a|m4v|fmp4)($|\?)/i.test(url)) return true
  if (/\b(segment|frag|chunk|Fragments)\b/i.test(url)) return true
  if (/googlevideo\.com\/videoplayback\b/i.test(url)) return true
  if (/\bakamaihd\.net\b.*\b(media|seg)\b/i.test(url)) return true
  if (/\bcloudfront\.net\b.*\.(ts|m4s)($|\?)/i.test(url)) return true
  return false
}

function parseHlsPlaylist(text, playlistUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const variants = []
  const segments = []
  let waitingForVariantUri = false
  let hasEndList = false
  const segmentDurations = []
  let pendingDuration = null

  for (const line of lines) {
    if (line.startsWith("#EXT-X-ENDLIST")) {
      hasEndList = true
      continue
    }
    if (line.startsWith("#EXTINF:")) {
      const match = line.match(/^#EXTINF:([0-9.]+)/i)
      const duration = match ? Number(match[1]) : NaN
      pendingDuration = Number.isFinite(duration) ? duration : null
      continue
    }
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      waitingForVariantUri = true
      continue
    }
    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF")) {
      const match = line.match(/URI="([^"]+)"/i)
      if (match?.[1]) {
        const absoluteVariant = toAbsoluteUrl(playlistUrl, match[1])
        if (absoluteVariant) variants.push(absoluteVariant)
      }
      continue
    }
    if (line.startsWith("#EXT-X-MAP")) {
      // Ignore initialization maps for anchor/prefetch sequencing.
      // They are commonly requested regardless of playback position and can
      // incorrectly drag anchor index back to 0 during active playback.
      continue
    }
    if (line.startsWith("#")) continue

    const absolute = toAbsoluteUrl(playlistUrl, line)
    if (!absolute) {
      waitingForVariantUri = false
      continue
    }
    if (waitingForVariantUri) {
      variants.push(absolute)
      waitingForVariantUri = false
      continue
    }
    segments.push(absolute)
    segmentDurations.push(
      Number.isFinite(pendingDuration) && pendingDuration !== null ? pendingDuration : null
    )
    pendingDuration = null
  }

  if (variants.length > 0 && segments.length === 0) {
    return {
      kind: "master",
      variants: Array.from(new Set(variants)),
      segments: [],
      isLive: false,
      segmentDurations: []
    }
  }

  return { kind: "media", variants: [], segments, isLive: !hasEndList, segmentDurations }
}

function parseDashPlaylist(text, playlistUrl) {
  const urls = new Set()
  const baseUrls = [playlistUrl]
  const baseRegex = /<BaseURL>([^<]+)<\/BaseURL>/gi
  for (const match of text.matchAll(baseRegex)) {
    const absolute = toAbsoluteUrl(playlistUrl, match[1])
    if (absolute) baseUrls.push(absolute)
  }
  const segmentUrlRegex = /<SegmentURL[^>]*media="([^"]+)"/gi
  for (const match of text.matchAll(segmentUrlRegex)) {
    for (const base of baseUrls) {
      const absolute = toAbsoluteUrl(base, match[1])
      if (absolute) urls.add(absolute)
    }
  }
  const templateRegex = /<SegmentTemplate[^>]*media="([^"]+)"/gi
  for (const match of text.matchAll(templateRegex)) {
    addLog("INFO", `DASH SegmentTemplate detected: ${match[1]}`)
  }
  return Array.from(urls)
}

function normalizeSegments(segments) {
  const normalized = []
  const seen = new Set()
  for (const segment of segments) {
    const absolute = stripHash(segment)
    if (!absolute || seen.has(absolute)) continue
    seen.add(absolute)
    normalized.push(absolute)
  }
  return normalized
}

function parseDurationTokenToSeconds(raw) {
  if (typeof raw !== "string") return null
  const value = raw.trim().toLowerCase()
  if (!value) return null
  if (/^\d+(\.\d+)?$/.test(value)) {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  const hmsMatch = value.match(
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s?)?$/
  )
  if (!hmsMatch) return null
  const hours = hmsMatch[1] ? Number(hmsMatch[1]) : 0
  const mins = hmsMatch[2] ? Number(hmsMatch[2]) : 0
  const secs = hmsMatch[3] ? Number(hmsMatch[3]) : 0
  const total = hours * 3600 + mins * 60 + secs
  return Number.isFinite(total) && total > 0 ? total : null
}

function extractStartSecondsFromPageUrl(pageUrl) {
  if (typeof pageUrl !== "string" || !pageUrl) return null
  try {
    const parsed = new URL(pageUrl)
    const candidates = [
      parsed.searchParams.get("t"),
      parsed.searchParams.get("start"),
      parsed.searchParams.get("time_continue")
    ].filter(Boolean)
    if (parsed.hash && parsed.hash.includes("t=")) {
      const hashMatch = parsed.hash.match(/(?:^|[?&#])t=([^&#]+)/i)
      if (hashMatch?.[1]) candidates.push(hashMatch[1])
    }
    for (const token of candidates) {
      const seconds = parseDurationTokenToSeconds(token)
      if (seconds !== null) return seconds
    }
  } catch {
    return null
  }
  return null
}

ns.stripHash = stripHash
ns.buildCacheKeyVariants = buildCacheKeyVariants
ns.isUmpCacheKey = isUmpCacheKey
ns.getUmpBodyHashFromCacheKey = getUmpBodyHashFromCacheKey
ns.arrayBufferToBase64 = arrayBufferToBase64
ns.base64ToArrayBuffer = base64ToArrayBuffer
ns.extractMessageBytes = extractMessageBytes
ns.isPlaylistUrl = isPlaylistUrl
ns.isLikelyChunkUrl = isLikelyChunkUrl
ns.parseHlsPlaylist = parseHlsPlaylist
ns.parseDashPlaylist = parseDashPlaylist
ns.normalizeSegments = normalizeSegments
ns.extractStartSecondsFromPageUrl = extractStartSecondsFromPageUrl
})()
