(() => {
var ns = (self.AegisBackground ||= {})
const { state, isTwitchMediaUrl, TWITCH_CLIENT_ID, TWITCH_ORIGIN, TWITCH_REFERER } = ns

const SESSION_TTL_MS = 120_000
const MAX_SESSIONS = 64
const SSAI_SKIP_LOG_THROTTLE_MS = 15_000

const ssaiSkipLogAt = new Map()

function emptySession() {
  return { token: null, sig: null, updatedAt: 0 }
}

function getTwitchSession(tabId) {
  if (!Number.isFinite(tabId) || tabId < 0) return emptySession()
  if (!state.twitchSessionByTab) state.twitchSessionByTab = new Map()
  return state.twitchSessionByTab.get(tabId) || emptySession()
}

function pruneTwitchSessions() {
  const map = state.twitchSessionByTab
  if (!map || map.size <= MAX_SESSIONS) return
  const now = Date.now()
  for (const [tabId, session] of map.entries()) {
    if (now - Number(session?.updatedAt || 0) > SESSION_TTL_MS * 2) {
      map.delete(tabId)
    }
  }
}

/**
 * SureStream / SSAI and interleaved ad tracks must not overwrite stream session tokens.
 */
function isTwitchSsaiOrAdUrl(url) {
  if (typeof url !== "string" || !url) return false

  const lower = url.toLowerCase()
  if (lower.includes("amazon-adsystem")) return true

  try {
    const parsed = new URL(url)
    const host = (parsed.hostname || "").toLowerCase()
    const path = parsed.pathname || ""
    const pathLower = path.toLowerCase()

    if (/\/ads?\//.test(pathLower)) return true
    if (/index-muted/i.test(path) || /index-muted/i.test(parsed.href)) return true
    if (/surestream|stitched[-_]?ad|\/ssai\//i.test(`${path}${parsed.search}`)) return true

    // Ad-only CloudFront hosts (stream weave stays on *.ttvnw.net / *.jtvnw.net).
    if (host.endsWith(".cloudfront.net") && !host.includes("ttvnw.net") && !host.includes("jtvnw.net")) {
      return true
    }
    if (lower.includes("cloudfront") && /\/ads?\//.test(pathLower)) return true

    return false
  } catch {
    return /\/ad\/|\/ads\/|index-muted|amazon-adsystem/i.test(lower)
  }
}

function isTrustedTwitchStreamAuthSource(url) {
  if (!isTwitchMediaUrl(url)) return false
  return !isTwitchSsaiOrAdUrl(url)
}

function logSsaiSessionSkip(tabId, url) {
  if (typeof ns.addLog !== "function") return
  const key = `${tabId}:${url.slice(-96)}`
  const now = Date.now()
  if (now - Number(ssaiSkipLogAt.get(key) || 0) < SSAI_SKIP_LOG_THROTTLE_MS) return
  ssaiSkipLogAt.set(key, now)
  if (ssaiSkipLogAt.size > 200) {
    const cutoff = now - SSAI_SKIP_LOG_THROTTLE_MS * 2
    for (const [entryKey, ts] of ssaiSkipLogAt.entries()) {
      if (ts < cutoff) ssaiSkipLogAt.delete(entryKey)
    }
  }
  ns.addLog(
    "DEBUG",
    `Twitch SSAI/ad asset skipped for session cache (tab ${tabId}): ${url.slice(-80)}`
  )
}

function extractAuthParams(url) {
  try {
    const parsed = new URL(url)
    const token = parsed.searchParams.get("token")
    const sig = parsed.searchParams.get("sig")
    if (!token || !sig) return null
    return { token, sig }
  } catch {
    return null
  }
}

function saveTabSessionTokens(tabId, auth) {
  if (!state.twitchSessionByTab) state.twitchSessionByTab = new Map()
  state.twitchSessionByTab.set(tabId, {
    token: auth.token,
    sig: auth.sig,
    updatedAt: Date.now()
  })
  pruneTwitchSessions()
}

function noteTwitchAuthFromUrl(tabId, url) {
  if (!Number.isFinite(tabId) || tabId < 0 || !url) return
  if (!isTrustedTwitchStreamAuthSource(url)) {
    if (isTwitchMediaUrl(url) && isTwitchSsaiOrAdUrl(url)) {
      logSsaiSessionSkip(tabId, url)
    }
    return
  }

  const auth = extractAuthParams(url)
  if (!auth) return
  saveTabSessionTokens(tabId, auth)
}

function applyTwitchSessionToUrl(tabId, url) {
  if (!url || !isTwitchMediaUrl(url)) return url
  if (isTwitchSsaiOrAdUrl(url)) return url

  const session = getTwitchSession(tabId)
  if (!session.token || !session.sig) return url
  if (Date.now() - Number(session.updatedAt || 0) > SESSION_TTL_MS) return url
  try {
    const parsed = new URL(url)
    if (!parsed.searchParams.has("token")) parsed.searchParams.set("token", session.token)
    if (!parsed.searchParams.has("sig")) parsed.searchParams.set("sig", session.sig)
    return parsed.toString()
  } catch {
    return url
  }
}

function mergeTwitchRequestHeaders(url, headers, tabId) {
  const out = new Headers()
  if (headers && typeof headers.forEach === "function") {
    headers.forEach((value, key) => out.set(key, value))
  } else if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key && value != null) out.set(key, String(value))
    }
  }
  if (!isTwitchMediaUrl(url)) return out

  if (!out.has("Client-ID")) out.set("Client-ID", TWITCH_CLIENT_ID)
  if (!out.has("Origin")) out.set("Origin", TWITCH_ORIGIN)
  if (!out.has("Referer")) out.set("Referer", TWITCH_REFERER)
  return out
}

ns.getTwitchSession = getTwitchSession
ns.isTwitchSsaiOrAdUrl = isTwitchSsaiOrAdUrl
ns.isTrustedTwitchStreamAuthSource = isTrustedTwitchStreamAuthSource
ns.noteTwitchAuthFromUrl = noteTwitchAuthFromUrl
ns.applyTwitchSessionToUrl = applyTwitchSessionToUrl
ns.mergeTwitchRequestHeaders = mergeTwitchRequestHeaders
})()
