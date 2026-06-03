(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("smoother-install")) return

function installPageSmoother() {

  if (typeof ns.installHoverPrefetch === "function") {
    const startHover = () => ns.installHoverPrefetch()
    if (document.body) startHover()
    else document.addEventListener("DOMContentLoaded", startHover, { once: true })
  }

  if (typeof ns.installViewportPreconnect === "function") {
    ns.installViewportPreconnect()
  }
}

ns.installPageSmoother = installPageSmoother
})()
