(() => {
var ns = (self.AegisBackground ||= {})

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
  if (/\bakamaihd\.net\b.*\b(media|seg)\b/i.test(url)) return true
  if (/\bcloudfront\.net\b.*\.(ts|m4s)($|\?)/i.test(url)) return true
  if (/\bttvnw\.net\b/i.test(url)) return true
  if (/\bjtvnw\.net\b/i.test(url)) return true
  return false
}

ns.isPlaylistUrl = isPlaylistUrl
ns.isLikelyChunkUrl = isLikelyChunkUrl
})()
