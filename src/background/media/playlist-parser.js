(() => {
var ns = (self.AegisBackground ||= {})
const { addLog, stripHash } = ns

function toAbsoluteUrl(baseUrl, candidate) {
  try {
    return stripHash(new URL(candidate, baseUrl).toString())
  } catch {
    return null
  }
}

function parseByteRangeValue(raw) {
  if (typeof raw !== "string" || !raw) return null
  const cleaned = raw.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "")
  const match = cleaned.match(/^(\d+)(?:@(\d+))?$/)
  if (!match) return null
  const length = Number(match[1])
  if (!Number.isFinite(length) || length <= 0) return null
  const offset = match[2] != null ? Number(match[2]) : null
  return {
    length,
    offset: Number.isFinite(offset) ? offset : null
  }
}

function parseByteRangeTag(line) {
  const match = String(line || "").match(/^#EXT-X-BYTERANGE\s*:\s*(.+)$/i)
  if (!match?.[1]) return null
  return parseByteRangeValue(match[1])
}

function applyByteRangeToUrl(absolute, byteRange, nextByteRangeOffset) {
  if (!absolute || !byteRange) {
    return { segmentRef: absolute, nextOffset: 0 }
  }
  const start = byteRange.offset != null ? byteRange.offset : nextByteRangeOffset
  const end = start + byteRange.length - 1
  const ranged =
    typeof ns.formatAegisByteRangeRef === "function"
      ? ns.formatAegisByteRangeRef(absolute, start, end)
      : `${absolute}#aegis-bytes=${start}-${end}`
  return {
    segmentRef: ranged || absolute,
    nextOffset: end + 1
  }
}

const INVALID_HLS_RESULT = Object.freeze({
  kind: "invalid",
  variants: [],
  segments: [],
  isLive: false,
  segmentDurations: [],
  discontinuityMarkers: [],
  mediaSequence: null,
  totalDuration: null
})

/**
 * Some sites (e.g. flixcloud-style embeds) serve an encrypted/obfuscated blob with a
 * `.m3u8` URL or `application/vnd.apple.mpegurl` content-type as an anti-scraping measure;
 * their own page JS decrypts it before handing real text to hls.js. Without the real text
 * we cannot extract segments — attempting to anyway turns the whole blob into one bogus
 * "segment" URL (via new URL(garbage, base)) that will never resolve, causing endless
 * prefetch 404s and buffer-rescue thrashing. Detect and bail out cleanly instead.
 */
function looksLikeHlsPlaylistText(text) {
  return typeof text === "string" && text.trimStart().startsWith("#EXTM3U")
}

function parseHlsPlaylist(text, playlistUrl) {
  if (!looksLikeHlsPlaylistText(text)) {
    if (typeof addLog === "function" && typeof text === "string" && text.length > 200) {
      addLog(
        "DEBUG",
        `Playlist body doesn't start with #EXTM3U (${text.length} chars) — likely encrypted/obfuscated by the site; skipping unparseable capture: ${
          playlistUrl ? String(playlistUrl).slice(-60) : "(no url)"
        }`
      )
    }
    return INVALID_HLS_RESULT
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const variants = []
  const segments = []
  let waitingForVariantUri = false
  let pendingVariantMeta = null
  let hasEndList = false
  const segmentDurations = []
  const discontinuityMarkers = []
  let pendingDuration = null
  let pendingDiscontinuity = false
  let pendingByteRange = null
  let nextByteRangeOffset = 0
  let mediaSequence = null
  // Some packagers emit URI then #EXT-X-BYTERANGE (non-spec). Track last bare URI.
  let lastBareSegmentIndex = -1
  // fMP4 VOD often omits repeated media URIs after the first segment / MAP.
  let lastMediaUri = null

  function pushSegment(absoluteUrl, byteRange) {
    if (!absoluteUrl) return
    let segmentRef = absoluteUrl
    if (byteRange) {
      const applied = applyByteRangeToUrl(absoluteUrl, byteRange, nextByteRangeOffset)
      segmentRef = applied.segmentRef
      nextByteRangeOffset = applied.nextOffset
    } else {
      nextByteRangeOffset = 0
    }
    segments.push(segmentRef)
    lastBareSegmentIndex = byteRange ? -1 : segments.length - 1
    lastMediaUri = absoluteUrl
    segmentDurations.push(
      Number.isFinite(pendingDuration) && pendingDuration !== null ? pendingDuration : null
    )
    discontinuityMarkers.push(pendingDiscontinuity ? 1 : 0)
    pendingDiscontinuity = false
    pendingDuration = null
    pendingByteRange = null
  }

  /** Flush a completed EXTINF[+BYTERANGE] that omitted its URI (reuse last media URI). */
  function flushOmittedUriSegment() {
    if (!lastMediaUri || !pendingByteRange) return false
    pushSegment(lastMediaUri, pendingByteRange)
    return true
  }

  for (const line of lines) {
    if (line.startsWith("#EXT-X-ENDLIST")) {
      flushOmittedUriSegment()
      hasEndList = true
      continue
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const match = line.match(/^#EXT-X-MEDIA-SEQUENCE:\s*(\d+)/i)
      if (match?.[1]) {
        mediaSequence = Number(match[1])
      }
      continue
    }
    if (line.startsWith("#EXT-X-DISCONTINUITY")) {
      flushOmittedUriSegment()
      pendingDiscontinuity = true
      continue
    }
    if (line.startsWith("#EXTINF:")) {
      // New EXTINF while a prior BYTERANGE is still open => previous segment omitted its URI.
      if (pendingByteRange && lastMediaUri) {
        flushOmittedUriSegment()
      }
      const match = line.match(/^#EXTINF:\s*([0-9.]+)/i)
      const duration = match ? Number(match[1]) : NaN
      pendingDuration = Number.isFinite(duration) ? duration : null
      continue
    }
    if (line.startsWith("#EXT-X-BYTERANGE")) {
      const parsedRange = parseByteRangeTag(line)
      if (!parsedRange) continue
      // Spec: BYTERANGE precedes URI. Non-spec: BYTERANGE follows URI — patch last bare seg.
      if (
        lastBareSegmentIndex >= 0 &&
        lastBareSegmentIndex < segments.length &&
        !pendingByteRange
      ) {
        const bareUrl =
          typeof ns.stripHash === "function"
            ? ns.stripHash(segments[lastBareSegmentIndex])
            : String(segments[lastBareSegmentIndex] || "").split("#")[0]
        const applied = applyByteRangeToUrl(bareUrl, parsedRange, nextByteRangeOffset)
        segments[lastBareSegmentIndex] = applied.segmentRef
        nextByteRangeOffset = applied.nextOffset
        lastBareSegmentIndex = -1
        lastMediaUri = bareUrl || lastMediaUri
        continue
      }
      // Another BYTERANGE while one is pending => flush omitted-URI segment first.
      if (pendingByteRange && lastMediaUri) {
        flushOmittedUriSegment()
      }
      pendingByteRange = parsedRange
      continue
    }
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      waitingForVariantUri = true
      const bwMatch = line.match(/BANDWIDTH=(\d+)/i)
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i)
      pendingVariantMeta = {
        bandwidth: bwMatch?.[1] ? Number(bwMatch[1]) : 0,
        resolution: resMatch?.[1] || null
      }
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
      const mapUri = line.match(/URI\s*=\s*"([^"]+)"/i)
      if (mapUri?.[1]) {
        const absoluteMap = toAbsoluteUrl(playlistUrl, mapUri[1])
        if (absoluteMap) lastMediaUri = absoluteMap
      }
      // Init segment may carry BYTERANGE="len@offset" — keep offset continuity.
      const mapRange = line.match(/BYTERANGE\s*=\s*"([^"]+)"/i)
      if (mapRange?.[1]) {
        const parsed = parseByteRangeValue(mapRange[1])
        if (parsed) {
          const start = parsed.offset != null ? parsed.offset : 0
          nextByteRangeOffset = start + parsed.length
        }
      }
      continue
    }
    if (line.startsWith("#")) continue

    const absolute = toAbsoluteUrl(playlistUrl, line)
    if (!absolute) {
      waitingForVariantUri = false
      continue
    }
    if (waitingForVariantUri) {
      const meta = pendingVariantMeta || { bandwidth: 0, resolution: null }
      const label =
        meta.resolution ||
        (meta.bandwidth >= 1_000_000
          ? `${Math.round(meta.bandwidth / 1_000_000)}M`
          : meta.bandwidth > 0
            ? `${Math.round(meta.bandwidth / 1000)}k`
            : `variant-${variants.length + 1}`)
      variants.push({
        url: absolute,
        bandwidth: meta.bandwidth,
        resolution: meta.resolution,
        label
      })
      waitingForVariantUri = false
      pendingVariantMeta = null
      continue
    }

    pushSegment(absolute, pendingByteRange)
  }

  // Trailing omitted-URI segment (no ENDLIST / no following EXTINF).
  flushOmittedUriSegment()

  let totalDuration = 0
  for (const duration of segmentDurations) {
    if (Number.isFinite(duration) && duration > 0) totalDuration += duration
  }

  if (variants.length > 0 && segments.length === 0) {
    const uniqueVariants = []
    const seenUrls = new Set()
    for (const entry of variants) {
      const url = typeof entry === "string" ? entry : entry?.url
      if (!url || seenUrls.has(url)) continue
      seenUrls.add(url)
      uniqueVariants.push(
        typeof entry === "string"
          ? { url: entry, bandwidth: 0, resolution: null, label: `variant-${uniqueVariants.length + 1}` }
          : entry
      )
    }
    return {
      kind: "master",
      variants: uniqueVariants,
      segments: [],
      isLive: false,
      segmentDurations: [],
      discontinuityMarkers: [],
      mediaSequence: null,
      totalDuration: null
    }
  }

  // Diagnostic: a large playlist payload should not collapse to <=1 segment. Gate on raw
  // text size (not line count) — a packager can pack a huge playlist into very few lines
  // when URIs/tokens are long, so line-count alone would miss that case.
  if (segments.length <= 1 && text.length > 2000 && typeof addLog === "function") {
    const tagCounts = {}
    for (const line of lines) {
      if (!line.startsWith("#")) continue
      const tag = line.split(/[:\s=]/, 1)[0]
      tagCounts[tag] = (tagCounts[tag] || 0) + 1
    }
    addLog(
      "WARN",
      `Media playlist parsed to ${segments.length} segment(s) from ${text.length} chars / ${lines.length} lines — tag shape: ${JSON.stringify(tagCounts)}`
    )
    addLog(
      "DEBUG",
      `Playlist sample (first 20 lines, truncated to 200 chars each): ${JSON.stringify(
        lines.slice(0, 20).map((line) => (line.length > 200 ? `${line.slice(0, 200)}…(${line.length} chars)` : line))
      )}`
    )
  }

  return {
    kind: "media",
    variants: [],
    segments,
    isLive: !hasEndList,
    segmentDurations,
    discontinuityMarkers,
    mediaSequence: Number.isFinite(mediaSequence) ? mediaSequence : null,
    totalDuration: totalDuration > 0 ? totalDuration : null
  }
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
    const absolute =
      typeof ns.normalizeSegmentRef === "function"
        ? ns.normalizeSegmentRef(segment)
        : stripHash(segment)
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

ns.parseHlsPlaylist = parseHlsPlaylist
ns.parseDashPlaylist = parseDashPlaylist
ns.normalizeSegments = normalizeSegments
ns.extractStartSecondsFromPageUrl = extractStartSecondsFromPageUrl
})()
