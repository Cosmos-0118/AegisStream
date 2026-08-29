(() => {
var ns = (self.AegisBackground ||= {})
const { addLog } = ns

/**
 * Referer/Origin for the extension's own media fetches.
 *
 * The page's fetches carry a Referer automatically; the service worker's do
 * not. `manifest-fetch-coalescer` issues a bare `fetch(url, {credentials:
 * "include"})` with no headers at all, so hosts that enforce hotlink
 * protection answer it with 403 while the identical request from the page
 * succeeds. Referer is a forbidden header name for `fetch()`, so it cannot be
 * set from JS — declarativeNetRequest is the only route.
 *
 * Rules are SESSION-scoped rather than dynamic for two reasons: `tabIds` is
 * only honoured on session rules, and these are per-playback facts that should
 * not outlive the browser session. `tabIds: [-1]` matches requests that do not
 * originate from a tab, i.e. exactly the extension's own fetches — the page's
 * requests are never touched, so a wrong guess here cannot break playback.
 */

const RULE_ID_BASE = 9000
const RULE_ID_LIMIT = 128

// host -> { ruleId, referer }
const hostRules = new Map()
let nextRuleId = RULE_ID_BASE

function dnrAvailable() {
  return (
    typeof chrome !== "undefined" &&
    chrome.declarativeNetRequest &&
    typeof chrome.declarativeNetRequest.updateSessionRules === "function"
  )
}

/** Cross-origin requests send only the origin under the default referrer policy. */
function refererFromPageUrl(pageUrl) {
  if (typeof pageUrl !== "string" || !pageUrl) return null
  try {
    const parsed = new URL(pageUrl)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return { origin: parsed.origin, referer: `${parsed.origin}/` }
  } catch {
    return null
  }
}

function hostFromUrl(url) {
  if (typeof url !== "string" || !url) return null
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

function allocateRuleId() {
  const id = nextRuleId
  nextRuleId = nextRuleId + 1 >= RULE_ID_BASE + RULE_ID_LIMIT ? RULE_ID_BASE : nextRuleId + 1
  return id
}

/**
 * Ensure extension-initiated requests to `mediaUrl`'s host present the page's
 * Referer/Origin. No-ops when nothing changed, so it is safe to call on every
 * refresh attempt.
 */
ns.ensureMediaRefererRule = async function ensureMediaRefererRule(mediaUrl, pageUrl) {
  if (!dnrAvailable()) return false
  const host = hostFromUrl(mediaUrl)
  const identity = refererFromPageUrl(pageUrl)
  if (!host || !identity) return false
  // A same-host referer is what the request would carry anyway.
  if (identity.origin === `https://${host}` || identity.origin === `http://${host}`) return false

  const existing = hostRules.get(host)
  if (existing && existing.referer === identity.referer) return true

  const ruleId = existing?.ruleId || allocateRuleId()
  const rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "Referer", operation: "set", value: identity.referer },
        { header: "Origin", operation: "set", value: identity.origin }
      ]
    },
    condition: {
      urlFilter: `||${host}^`,
      resourceTypes: ["xmlhttprequest", "other"],
      // Extension-initiated only. Never rewrites the page's own requests.
      tabIds: [-1]
    }
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId],
      addRules: [rule]
    })
  } catch (e) {
    addLog("WARN", `Could not install media referer rule for ${host}: ${e.message}`)
    return false
  }

  hostRules.set(host, { ruleId, referer: identity.referer })
  addLog("DEBUG", `Media referer rule active for ${host} (referer=${identity.referer})`)
  return true
}

ns.clearMediaRefererRules = async function clearMediaRefererRules() {
  if (!dnrAvailable() || hostRules.size === 0) return
  const removeRuleIds = [...hostRules.values()].map((entry) => entry.ruleId)
  hostRules.clear()
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: [] })
  } catch {
    // Session rules die with the browser session regardless.
  }
}

ns.getMediaRefererRuleForHost = function getMediaRefererRuleForHost(host) {
  return hostRules.get(host) || null
}
})()
