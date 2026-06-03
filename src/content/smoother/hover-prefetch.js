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
  if (!smoother.isNavigableLink(link)) return
  const href = link.href
  const injected = smoother.injectHeadLink("prefetch", href, { as: "document" })
  if (injected && typeof logBridge === "function") {
    logBridge(`Hover-prefetch queued: ${href.slice(0, 96)}`, "DEBUG")
  }
  if (typeof ns.notifyRuntime === "function") {
    ns.notifyRuntime("ARM_HEADER_HINTS", { targetUrl: href, reason: "hover" })
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
  if (!smoother.isNavigableLink(link)) return

  activeLink = link
  hoverTimeout = setTimeout(() => {
    hoverTimeout = null
    if (activeLink === link && smoother.isNavigableLink(link)) {
      prefetchDocumentForLink(link)
    }
  }, smoother.HOVER_THRESHOLD_MS)
}

function onPointerOut(event) {
  const link = event.target?.closest?.("a")
  if (!link || link !== activeLink) return
  clearHoverTimer()
}

function installHoverPrefetch() {
  if (ns.__hoverPrefetchInstalled === true) return
  ns.__hoverPrefetchInstalled = true

  const root = document.documentElement || document
  root.addEventListener("pointerover", onPointerOver, true)
  root.addEventListener("pointerout", onPointerOut, true)
  if (typeof logBridge === "function") {
    logBridge("Hover-prefetch engine active", "DEBUG")
  }
}

ns.installHoverPrefetch = installHoverPrefetch
})()
