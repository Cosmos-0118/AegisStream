(() => {
var ns = (self.AegisPageBridge ||= {})
const smoother = ns.smoother
const logBridge = ns.logBridge
if (!smoother?.isNavigableLink) return

let hoverTimeout = null
let activeLink = null

function clearHoverTimer() {
  if (hoverTimeout !== null) {
    clearTimeout(hoverTimeout)
    hoverTimeout = null
  }
  activeLink = null
}

function prefetchDocumentForLink(link) {
  if (typeof smoother.shouldAllowNavigationBoost === "function") {
    if (!smoother.shouldAllowNavigationBoost(link)) return
  } else if (!smoother.isNavigableLink(link)) {
    return
  }

  try {
    const parsed = new URL(link.href, location.href)
    // Light hint only — rel=prefetch as=document triggers full HTML fetches per sidebar link.
    const injected = smoother.injectHeadLink("dns-prefetch", parsed.origin)
    if (injected && typeof logBridge === "function") {
      logBridge(`Hover dns-prefetch: ${parsed.origin}`, "DEBUG")
    }
  } catch {
    // ignore
  }
}

function onPointerOver(event) {
  const link = event.target?.closest?.("a")
  if (!link) {
    clearHoverTimer()
    return
  }
  if (link === activeLink) return
  clearHoverTimer()
  if (typeof smoother.shouldAllowNavigationBoost === "function") {
    if (!smoother.shouldAllowNavigationBoost(link)) return
  } else if (!smoother.isNavigableLink(link)) {
    return
  }

  activeLink = link
  const delayMs =
    typeof smoother.resolveHoverThresholdMs === "function"
      ? smoother.resolveHoverThresholdMs()
      : smoother.HOVER_THRESHOLD_MS
  hoverTimeout = setTimeout(() => {
    hoverTimeout = null
    if (activeLink === link) {
      prefetchDocumentForLink(link)
    }
  }, delayMs)
}

function onPointerOut(event) {
  const link = event.target?.closest?.("a")
  if (!link || link !== activeLink) return
  clearHoverTimer()
}

function installHoverPrefetch() {
  if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("hover-prefetch")) return

  const root = document.documentElement || document
  root.addEventListener("pointerover", onPointerOver, true)
  root.addEventListener("pointerout", onPointerOut, true)
  if (typeof logBridge === "function") {
    logBridge("Hover-prefetch engine active (dns-prefetch only)", "DEBUG")
  }
}

ns.installHoverPrefetch = installHoverPrefetch
})()
