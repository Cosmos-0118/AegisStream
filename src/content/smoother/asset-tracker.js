(() => {
if (globalThis.__aegisAssetTrackerInstalled === true) return
globalThis.__aegisAssetTrackerInstalled = true

const MAX_SCRIPT_ASSETS = 6
const SPA_DELAYS_MS = [0, 2000, 6000]
const DOM_QUIET_MS = 1200

let lastPublishedSignature = ""
let domQuietTimer = null
let scheduledDelays = new Set()

function isSkippedHost() {
  const host = location.hostname || ""
  return host === "youtube.com" || host.endsWith(".youtube.com")
}

function isBlockingScript(el) {
  if (!el?.src) return false
  if (el.async || el.defer) return false
  if ((el.type || "").toLowerCase() === "module") return false
  return true
}

function collectLayoutAssets() {
  const styles = []
  const scripts = []
  const seen = new Set()

  const pushUnique = (list, entry) => {
    const key = `${entry.type}|${entry.url}`
    if (seen.has(key)) return
    seen.add(key)
    list.push(entry)
  }

  for (const el of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    pushUnique(styles, { url: el.href, type: "style" })
  }

  for (const el of document.querySelectorAll('link[rel~="preload"][href][as]')) {
    const as = (el.getAttribute("as") || "").toLowerCase()
    if (as === "style" || as === "script" || as === "font") {
      pushUnique(styles, { url: el.href, type: as === "font" ? "style" : as })
    }
  }

  for (const el of document.querySelectorAll("script[src]")) {
    if (!isBlockingScript(el)) continue
    pushUnique(scripts, { url: el.src, type: "script" })
    if (scripts.length >= MAX_SCRIPT_ASSETS) break
  }

  return [...styles, ...scripts]
}

function buildSignature(assets) {
  return assets.map((a) => `${a.type}|${a.url}`).join("\n")
}

function publishLayoutAssets(reason = "load") {
  if (isSkippedHost()) return
  const assets = collectLayoutAssets()
  if (assets.length === 0) return

  const signature = buildSignature(assets)
  if (signature === lastPublishedSignature && reason !== "spa-route") return
  lastPublishedSignature = signature

  try {
    chrome.runtime.sendMessage({
      type: "AegisStream:RecordLayoutAssets",
      origin: location.origin,
      pathname: location.pathname,
      assets,
      reason
    })
  } catch {
    // Extension context may be invalidated
  }
}

function scheduleSpaPasses(reasonBase) {
  for (const delay of SPA_DELAYS_MS) {
    const key = `${reasonBase}:${delay}`
    if (scheduledDelays.has(key)) continue
    scheduledDelays.add(key)
    setTimeout(() => {
      scheduledDelays.delete(key)
      publishLayoutAssets(`${reasonBase}-${delay}ms`)
    }, delay)
  }
}

function scheduleDomQuietPublish() {
  if (domQuietTimer) clearTimeout(domQuietTimer)
  domQuietTimer = setTimeout(() => {
    domQuietTimer = null
    publishLayoutAssets("dom-quiet")
  }, DOM_QUIET_MS)
}

function hookHistory() {
  const fire = () => {
    lastPublishedSignature = ""
    publishLayoutAssets("spa-route")
    scheduleSpaPasses("spa")
  }
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState
  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args)
    fire()
    return result
  }
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args)
    fire()
    return result
  }
  window.addEventListener("popstate", fire)
}

function boot() {
  scheduleSpaPasses("load")
  hookHistory()

  if (typeof MutationObserver === "function" && document.documentElement) {
    const observer = new MutationObserver((records) => {
      let touched = false
      for (const record of records) {
        if (record.type === "childList" && (record.addedNodes.length || record.removedNodes.length)) {
          touched = true
          break
        }
      }
      if (touched) scheduleDomQuietPublish()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true })
} else {
  boot()
}

window.addEventListener("load", () => publishLayoutAssets("load"), { once: true })
window.addEventListener("pageshow", (event) => {
  lastPublishedSignature = ""
  publishLayoutAssets(event.persisted ? "bfcache-restore" : "pageshow")
  scheduleSpaPasses("pageshow")
})
})()
