(() => {
var ns = (self.AegisPageBridge ||= {})

function installPageSmoother() {
  if (ns.__pageSmootherInstalled === true) return
  ns.__pageSmootherInstalled = true

  if (typeof ns.installHoverPrefetch === "function") {
    const startHover = () => ns.installHoverPrefetch()
    if (document.body) startHover()
    else document.addEventListener("DOMContentLoaded", startHover, { once: true })
  }

  if (typeof ns.installViewportPreconnect === "function") {
    ns.installViewportPreconnect()
  }

  if (typeof ns.installBfcacheEnforcer === "function") {
    ns.installBfcacheEnforcer()
  }
}

ns.installPageSmoother = installPageSmoother
})()
