(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("smoother-shared")) {
  return
}

const smoother = (ns.smoother ||= {})

const HOVER_THRESHOLD_MS = 65
/** Fallback when RTT cannot be estimated; live budget uses RTT × multiplier in circuit-breaker-timing.js */
const CIRCUIT_BREAKER_MS = 2500
const LOGOUT_PATTERN = /logout|signout|sign-out/i
const WATCH_PATH_PREFIX = /^\/watch\//i
const SITE_API_PREFIX = /^\/v2\/(api|auth)\b/i
const STATIC_ASSET_EXT = /\.(js|css|woff2?|ttf)(\?|$)/i
const MAX_INJECTED_HINTS = 500
const HOVER_THRESHOLD_DENSE_PAGE_MS = 280
/** Max unique origins to preconnect/dns-prefetch per page (link-heavy sites stay bounded). */
const VIEWPORT_PRECONNECT_ORIGIN_CAP = 50

const injectedHints = new Set()

function isSmootherSkippedHost(hostname) {
  if (globalThis.AegisSitePolicy?.isSmootherSkippedHost) {
    return globalThis.AegisSitePolicy.isSmootherSkippedHost(hostname)
  }
  if (typeof hostname !== "string" || hostname.length === 0) return true
  return (
    hostname === "googlevideo.com" ||
    hostname.endsWith(".googlevideo.com") ||
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com")
  )
}

function isSiteApiPath(pathname) {
  return SITE_API_PREFIX.test(pathname || "")
}

function isWatchPath(pathname) {
  return WATCH_PATH_PREFIX.test(pathname || "")
}

function countSameOriginWatchLinks() {
  if (typeof document === "undefined") return 0
  let count = 0
  for (const link of document.querySelectorAll("a[href]")) {
    try {
      const url = new URL(link.href, location.href)
      if (url.origin === location.origin && isWatchPath(url.pathname)) count += 1
    } catch {
      // ignore
    }
    if (count > 8) break
  }
  return count
}

function isLinkDensePage() {
  return isWatchPath(location.pathname) || countSameOriginWatchLinks() > 5
}

function isNavigableLink(link) {
  if (!link || link.tagName !== "A") return false
  const href = link.getAttribute("href")
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return false
  try {
    const url = new URL(link.href, location.href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (url.origin !== location.origin) return false
    if (LOGOUT_PATTERN.test(`${url.pathname}${url.search}`)) return false
    if (isSiteApiPath(url.pathname)) return false
    if (url.search && url.search.length > 1) return false
    if (link.target && link.target !== "_self") return false
    if (link.hasAttribute("download")) return false
    if (link.rel && /\bnoopener\b/i.test(link.rel)) return false
    return true
  } catch {
    return false
  }
}

/** Hover/viewport boosts: skip sidebar episode hops while already on a watch page. */
function shouldAllowNavigationBoost(link) {
  if (!isNavigableLink(link)) return false
  try {
    const target = new URL(link.href, location.href)
    if (isWatchPath(location.pathname) && isWatchPath(target.pathname)) return false
    return true
  } catch {
    return false
  }
}

function resolveHoverThresholdMs() {
  return isLinkDensePage() ? HOVER_THRESHOLD_DENSE_PAGE_MS : HOVER_THRESHOLD_MS
}

function linkOrigin(link) {
  try {
    const url = new URL(link.href, location.href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.origin
  } catch {
    return null
  }
}

function normalizeHintKey(rel, href) {
  return `${rel}|${href}`
}

function injectHeadLink(rel, href, extra = {}) {
  if (!document.head || !href) return false
  const key = normalizeHintKey(rel, href)
  if (injectedHints.has(key)) return false
  injectedHints.add(key)
  if (injectedHints.size > MAX_INJECTED_HINTS) {
    const oldest = injectedHints.values().next().value
    injectedHints.delete(oldest)
  }
  const el = document.createElement("link")
  el.rel = rel
  el.href = href
  for (const [name, value] of Object.entries(extra)) {
    if (value != null) el.setAttribute(name, value)
  }
  document.head.appendChild(el)
  return true
}

function isCriticalStaticAsset(url, method = "GET") {
  if ((method || "GET").toUpperCase() !== "GET" || !url) return false
  try {
    const parsed = new URL(url, location.href)
    if (isSmootherSkippedHost(parsed.hostname)) return false
    return STATIC_ASSET_EXT.test(parsed.pathname)
  } catch {
    return false
  }
}

function appendCacheBust(url) {
  try {
    const parsed = new URL(url, location.href)
    parsed.searchParams.set("_aegis_cb", String(Date.now()))
    return parsed.toString()
  } catch {
    return url
  }
}

smoother.HOVER_THRESHOLD_MS = HOVER_THRESHOLD_MS
smoother.VIEWPORT_PRECONNECT_ORIGIN_CAP = VIEWPORT_PRECONNECT_ORIGIN_CAP
smoother.CIRCUIT_BREAKER_MS = CIRCUIT_BREAKER_MS
smoother.isSmootherSkippedHost = isSmootherSkippedHost
smoother.isSiteApiPath = isSiteApiPath
smoother.isWatchPath = isWatchPath
smoother.isLinkDensePage = isLinkDensePage
smoother.isNavigableLink = isNavigableLink
smoother.shouldAllowNavigationBoost = shouldAllowNavigationBoost
smoother.resolveHoverThresholdMs = resolveHoverThresholdMs
smoother.linkOrigin = linkOrigin
smoother.injectHeadLink = injectHeadLink
smoother.isCriticalStaticAsset = isCriticalStaticAsset
smoother.appendCacheBust = appendCacheBust
})()
