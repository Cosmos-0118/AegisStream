(() => {
var ns = (self.AegisPageBridge ||= {})
const smoother = ns.smoother
const logBridge = ns.logBridge
if (!smoother?.linkOrigin) return

const warmedOrigins = new Set()
let observer = null
let mutationObserver = null

function warmOriginForLink(link) {
  const origin = smoother.linkOrigin(link)
  if (!origin || warmedOrigins.has(origin)) return false

  try {
    const parsed = new URL(origin)
    if (smoother.isSmootherSkippedHost(parsed.hostname)) return false
  } catch {
    return false
  }

  warmedOrigins.add(origin)
  const originCap = smoother.VIEWPORT_PRECONNECT_ORIGIN_CAP || 50
  if (warmedOrigins.size > originCap) {
    const drop = warmedOrigins.values().next().value
    warmedOrigins.delete(drop)
  }

  const isSameOrigin = origin === location.origin
  if (isSameOrigin) {
    smoother.injectHeadLink("preconnect", origin)
  } else {
    smoother.injectHeadLink("dns-prefetch", origin)
    smoother.injectHeadLink("preconnect", origin, { crossorigin: "" })
  }
  if (typeof logBridge === "function") {
    logBridge(`Viewport warm: ${origin}`, "DEBUG")
  }
  return true
}

function observeLinks(root) {
  if (!observer) return
  const links = root.querySelectorAll?.("a[href]") || []
  for (const link of links) {
    if (link.href) observer.observe(link)
  }
}

function installViewportPreconnect() {
  if (ns.__viewportPreconnectInstalled === true) return
  if (typeof IntersectionObserver !== "function") return
  ns.__viewportPreconnectInstalled = true

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const link = entry.target
        if (link?.tagName === "A") warmOriginForLink(link)
        observer.unobserve(link)
      }
    },
    { root: null, rootMargin: "0px", threshold: 0.01 }
  )

  const boot = () => {
    observeLinks(document)
    if (typeof MutationObserver === "function" && document.body) {
      mutationObserver = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue
            if (node.tagName === "A" && node.href) {
              observer.observe(node)
            } else {
              observeLinks(node)
            }
          }
        }
      })
      mutationObserver.observe(document.body, { childList: true, subtree: true })
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true })
  } else {
    boot()
  }

  if (typeof logBridge === "function") {
    logBridge("Viewport preconnect engine active", "DEBUG")
  }
}

ns.installViewportPreconnect = installViewportPreconnect
})()
