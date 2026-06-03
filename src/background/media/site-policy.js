(() => {
var ns = (self.AegisBackground ||= {})
const { state } = ns

const TWITCH_CLIENT_ID = "kimne7vfc12a6wmd6w685up43b39dj"
const TWITCH_ORIGIN = "https://www.twitch.tv"
const TWITCH_REFERER = "https://www.twitch.tv/"

const TWITCH_PAGE_HOST_SUFFIXES = [".twitch.tv"]
const TWITCH_MEDIA_HOST_SUFFIXES = [".ttvnw.net", ".jtvnw.net"]

function normalizeHost(hostname) {
  return String(hostname || "").toLowerCase()
}

function hostMatchesSuffix(host, suffix) {
  const normalized = normalizeHost(host)
  if (!normalized) return false
  const bare = suffix.startsWith(".") ? suffix.slice(1) : suffix
  return normalized === bare || normalized.endsWith(suffix)
}

function isYouTubeHost(host) {
  const normalized = normalizeHost(host)
  if (!normalized) return false
  return normalized === "youtube.com" || normalized.endsWith(".youtube.com")
}

function isTwitchPageHost(host) {
  const normalized = normalizeHost(host)
  if (!normalized) return false
  if (normalized === "twitch.tv") return true
  return TWITCH_PAGE_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(normalized, suffix))
}

/** Pages where document/header boost breaks SPA + GraphQL (YouTube, Twitch). */
function isSkippableSmootherHost(host) {
  return isYouTubeHost(host) || isTwitchPageHost(host)
}

function isSkippableSmootherUrl(url) {
  if (typeof url !== "string" || !url) return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true
    return isSkippableSmootherHost(parsed.hostname)
  } catch {
    return true
  }
}

function isTwitchPageUrl(url) {
  if (typeof url !== "string" || !url) return false
  try {
    return isTwitchPageHost(new URL(url).hostname)
  } catch {
    return false
  }
}

function isTwitchMediaHost(host) {
  const normalized = normalizeHost(host)
  if (!normalized) return false
  if (isTwitchPageHost(normalized)) return true
  return TWITCH_MEDIA_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(normalized, suffix))
}

function isTwitchMediaUrl(url) {
  if (typeof url !== "string" || !url) return false
  try {
    const parsed = new URL(url)
    if (!isTwitchMediaHost(parsed.hostname)) return false
    if (/\.m3u8($|\?)/i.test(url)) return true
    if (/\.(ts|m4s|mp4|aac|cmfv|cmfa|cmft)($|\?)/i.test(url)) return true
    if (/video-weaver|playlist|segment|chunk/i.test(parsed.pathname)) return true
    return parsed.searchParams.has("token") || parsed.searchParams.has("sig")
  } catch {
    return false
  }
}

function noteTabPageUrl(tabId, pageUrl) {
  if (!Number.isFinite(tabId) || tabId < 0 || typeof pageUrl !== "string" || !pageUrl) return
  try {
    const host = normalizeHost(new URL(pageUrl).hostname)
    if (!host) return
    if (!state.tabPageHostByTab) state.tabPageHostByTab = new Map()
    state.tabPageHostByTab.set(tabId, host)
    const fingerprint =
      typeof ns.getPageUrlFingerprint === "function" ? ns.getPageUrlFingerprint(pageUrl) : null
    if (fingerprint) {
      if (!state.tabPageUrlFingerprintByTab) state.tabPageUrlFingerprintByTab = new Map()
      state.tabPageUrlFingerprintByTab.set(tabId, fingerprint)
    }
  } catch {
    // ignore
  }
}

function getTabPageHost(tabId) {
  if (!Number.isFinite(tabId) || tabId < 0) return null
  return state.tabPageHostByTab?.get(tabId) || null
}

function getTabPageUrlFingerprint(tabId) {
  if (!Number.isFinite(tabId) || tabId < 0) return null
  return state.tabPageUrlFingerprintByTab?.get(tabId) || null
}

function isReactivePrefetchTab(tabId) {
  const host = getTabPageHost(tabId)
  return host ? isTwitchPageHost(host) : false
}

function pruneTabPageHosts() {
  const map = state.tabPageHostByTab
  const fpMap = state.tabPageUrlFingerprintByTab
  if ((!map || map.size <= 200) && (!fpMap || fpMap.size <= 200)) return
  const keep = new Set(state.playlistByTab.keys())
  if (state.activePrefetchTabId != null) keep.add(state.activePrefetchTabId)
  if (map) {
    for (const tabId of map.keys()) {
      if (!keep.has(tabId)) map.delete(tabId)
    }
  }
  if (fpMap) {
    for (const tabId of fpMap.keys()) {
      if (!keep.has(tabId)) fpMap.delete(tabId)
    }
  }
}

ns.TWITCH_CLIENT_ID = TWITCH_CLIENT_ID
ns.TWITCH_ORIGIN = TWITCH_ORIGIN
ns.TWITCH_REFERER = TWITCH_REFERER
ns.isYouTubeHost = isYouTubeHost
ns.isTwitchPageHost = isTwitchPageHost
ns.isSkippableSmootherHost = isSkippableSmootherHost
ns.isSkippableSmootherUrl = isSkippableSmootherUrl
ns.isTwitchPageUrl = isTwitchPageUrl
ns.isTwitchMediaHost = isTwitchMediaHost
ns.isTwitchMediaUrl = isTwitchMediaUrl
ns.noteTabPageUrl = noteTabPageUrl
ns.getTabPageHost = getTabPageHost
ns.getTabPageUrlFingerprint = getTabPageUrlFingerprint
ns.isReactivePrefetchTab = isReactivePrefetchTab
ns.pruneTabPageHosts = pruneTabPageHosts
})()
