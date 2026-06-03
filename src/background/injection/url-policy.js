(() => {
var ns = (self.AegisBackground ||= {})

const BLOCKED_HOSTNAMES = new Set([
  "chrome.google.com",
  "chromewebstore.google.com",
  "chrome-devtools-frontend.appspot.com"
])

const BLOCKED_HOST_SUFFIXES = [".chrome.google.com"]

function isInjectablePageUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function isScriptInjectionAllowedUrl(url) {
  if (!isInjectablePageUrl(url)) return false
  try {
    const parsed = new URL(url)
    const host = (parsed.hostname || "").toLowerCase()
    if (!host) return false
    if (BLOCKED_HOSTNAMES.has(host)) return false
    for (const suffix of BLOCKED_HOST_SUFFIXES) {
      if (host === suffix.slice(1) || host.endsWith(suffix)) return false
    }
    if (host === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) return false
    return true
  } catch {
    return false
  }
}

function isRestrictedInjectionError(message) {
  if (typeof message !== "string") return false
  return /cannot access contents of the page|extension manifest must request permission/i.test(
    message
  )
}

ns.isInjectablePageUrl = isInjectablePageUrl
ns.isScriptInjectionAllowedUrl = isScriptInjectionAllowedUrl
ns.isRestrictedInjectionError = isRestrictedInjectionError
})()
