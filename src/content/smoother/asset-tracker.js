(() => {
if (globalThis.__aegisAssetTrackerInstalled === true) return
globalThis.__aegisAssetTrackerInstalled = true

const MAX_SCRIPT_ASSETS = 5

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

  for (const el of document.querySelectorAll('link[rel~="stylesheet"][href]')) {
    styles.push({ url: el.href, type: "style" })
  }

  for (const el of document.querySelectorAll("script[src]")) {
    if (!isBlockingScript(el)) continue
    scripts.push({ url: el.src, type: "script" })
    if (scripts.length >= MAX_SCRIPT_ASSETS) break
  }

  return [...styles, ...scripts]
}

function publishLayoutAssets(reason = "load") {
  if (isSkippedHost()) return
  const assets = collectLayoutAssets()
  if (assets.length === 0) return

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

function schedulePublish() {
  if (document.readyState === "complete") {
    publishLayoutAssets("load")
    return
  }
  window.addEventListener("load", () => publishLayoutAssets("load"), { once: true })
}

schedulePublish()
window.addEventListener("pageshow", (event) => {
  if (event.persisted) publishLayoutAssets("bfcache-restore")
})
})()
