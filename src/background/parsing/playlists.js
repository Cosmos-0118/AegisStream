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
  let mediaSequence = null

  for (const line of lines) {
    if (line.startsWith("#EXT-X-ENDLIST")) {
      hasEndList = true
      continue
    }
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const match = line.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/i)
      if (match?.[1]) {
        mediaSequence = Number(match[1])
      }
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

  let totalDuration = 0
  for (const duration of segmentDurations) {
    if (Number.isFinite(duration) && duration > 0) totalDuration += duration
  }

  if (variants.length > 0 && segments.length === 0) {
    return {
      kind: "master",
      variants: Array.from(new Set(variants)),
      segments: [],
      isLive: false,
      segmentDurations: [],
      mediaSequence: null,
      totalDuration: null
    }
  }

  return {
    kind: "media",
    variants: [],
    segments,
    isLive: !hasEndList,
    segmentDurations,
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

ns.parseHlsPlaylist = parseHlsPlaylist
ns.parseDashPlaylist = parseDashPlaylist
ns.normalizeSegments = normalizeSegments
ns.extractStartSecondsFromPageUrl = extractStartSecondsFromPageUrl
})()
