(() => {
var ns = (self.AegisBackground ||= {})

const SESSION_RULE_ID = 9001
const MAX_LINK_HEADER_CHARS = 6144
const MAX_LINK_ASSETS = 10
const HINT_LOG_THROTTLE_MS = 4000

const lastHintLogByKey = new Map()

function isSkippableDocumentUrl(url) {
  if (typeof url !== "string") return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true
    const host = parsed.hostname || ""
    return host === "youtube.com" || host.endsWith(".youtube.com")
  } catch {
    return true
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function buildDocumentCondition(documentUrl) {
  const parsed = new URL(documentUrl)
  const origin = parsed.origin
  const path =
    typeof ns.normalizePathname === "function"
      ? ns.normalizePathname(parsed.pathname)
      : parsed.pathname || "/"
  const pathPart = path === "/" ? "/" : path
  return {
    regexFilter: `^${escapeRegex(origin)}${escapeRegex(pathPart)}(\\?[^#]*)?(#.*)?$`,
    resourceTypes: ["main_frame"]
  }
}

function buildLinkHeaderValue(assets) {
  const parts = []
  for (const asset of assets || []) {
    if (!asset?.url || !asset?.as) continue
    if (asset.as !== "style" && asset.as !== "script" && asset.as !== "font") continue
    parts.push(`<${asset.url}>; rel=preload; as=${asset.as}`)
    if (parts.join(", ").length > MAX_LINK_HEADER_CHARS) break
    if (parts.length >= MAX_LINK_ASSETS) break
  }
  return parts.join(", ")
}

function shouldLogHint(key, level = "DEBUG") {
  const now = Date.now()
  const last = Number(lastHintLogByKey.get(key) || 0)
  if (level === "WARN" || now - last >= HINT_LOG_THROTTLE_MS) {
    lastHintLogByKey.set(key, now)
    return true
  }
  return false
}

async function clearHeaderSessionRule() {
  if (typeof chrome.declarativeNetRequest?.updateSessionRules !== "function") return
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SESSION_RULE_ID]
    })
  } catch {
    // ignore
  }
}

async function registerEarlyHints(targetUrl, assets, reason = "unknown", meta = {}) {
  if (typeof chrome.declarativeNetRequest?.updateSessionRules !== "function") {
    return { ok: false, error: "session-rules-unavailable" }
  }
  if (isSkippableDocumentUrl(targetUrl)) {
    return { ok: false, error: "skipped-host" }
  }

  const deduped = typeof ns.dedupeAssets === "function" ? ns.dedupeAssets(assets) : assets
  const linkHeaderValue = buildLinkHeaderValue(deduped)
  if (!linkHeaderValue) {
    await clearHeaderSessionRule()
    return { ok: false, error: "no-assets" }
  }

  const rule = {
    id: SESSION_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        {
          header: "Link",
          operation: "append",
          value: linkHeaderValue
        }
      ]
    },
    condition: buildDocumentCondition(targetUrl)
  }

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [SESSION_RULE_ID],
      addRules: [rule]
    })
    const logKey = `armed:${reason}:${new URL(targetUrl).origin}`
    if (shouldLogHint(logKey) && typeof ns.addLog === "function") {
      const pathNote = meta.matchedPath ? ` path=${meta.matchedPath}` : ""
      const fallbackNote = meta.fallback ? ` via ${meta.fallback}` : ""
      ns.addLog(
        "DEBUG",
        `Link header hints armed (${reason}, ${deduped.length} assets${pathNote}${fallbackNote}): ${targetUrl.slice(0, 96)}`
      )
    }
    return { ok: true, assetCount: deduped.length, matchedPath: meta.matchedPath || null }
  } catch (e) {
    if (typeof ns.addLog === "function") {
      ns.addLog("WARN", `Header hint session rule failed: ${e.message}`)
    }
    return { ok: false, error: e.message }
  }
}

async function armHeaderHintsForUrl(targetUrl, reason = "unknown") {
  const state = ns.state
  if (!state?.settings?.enabled || state.settings.headerEarlyHints === false) {
    return { ok: false, error: "disabled" }
  }
  if (isSkippableDocumentUrl(targetUrl)) {
    return { ok: false, error: "skipped-host" }
  }

  const lookup =
    typeof ns.lookupAssetsForUrl === "function"
      ? await ns.lookupAssetsForUrl(targetUrl)
      : { assets: [], matchedPath: null, fallback: null }

  const assets = lookup.assets || []
  if (!assets.length) {
    const missKey = `miss:${reason}:${new URL(targetUrl).origin}`
    if (shouldLogHint(missKey) && typeof ns.addLog === "function") {
      ns.addLog(
        "DEBUG",
        `Header hints not armed (${reason}, no layout cache): ${targetUrl.slice(0, 96)}`
      )
    }
    return { ok: false, error: "no-cached-layout" }
  }

  return registerEarlyHints(targetUrl, assets, reason, {
    matchedPath: lookup.matchedPath,
    fallback: lookup.fallback
  })
}

ns.SESSION_HEADER_RULE_ID = SESSION_RULE_ID
ns.registerEarlyHints = registerEarlyHints
ns.armHeaderHintsForUrl = armHeaderHintsForUrl
ns.clearHeaderSessionRule = clearHeaderSessionRule
ns.isSkippableHeaderHintUrl = isSkippableDocumentUrl
})()
