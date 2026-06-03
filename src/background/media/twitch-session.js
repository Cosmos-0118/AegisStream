(() => {
var ns = (self.AegisBackground ||= {})
const { state, isTwitchMediaUrl, TWITCH_CLIENT_ID, TWITCH_ORIGIN, TWITCH_REFERER } = ns

const SESSION_TTL_MS = 120_000
const MAX_SESSIONS = 64

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

function noteTwitchAuthFromUrl(tabId, url) {
  if (!Number.isFinite(tabId) || tabId < 0 || !isTwitchMediaUrl(url)) return
  const auth = extractAuthParams(url)
  if (!auth) return
  if (!state.twitchSessionByTab) state.twitchSessionByTab = new Map()
  state.twitchSessionByTab.set(tabId, {
    token: auth.token,
    sig: auth.sig,
    updatedAt: Date.now()
  })
  pruneTwitchSessions()
}

function applyTwitchSessionToUrl(tabId, url) {
  if (!url || !isTwitchMediaUrl(url)) return url
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
ns.noteTwitchAuthFromUrl = noteTwitchAuthFromUrl
ns.applyTwitchSessionToUrl = applyTwitchSessionToUrl
ns.mergeTwitchRequestHeaders = mergeTwitchRequestHeaders
})()
