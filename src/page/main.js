(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("main")) return
if (
  typeof ns.logBridge !== "function" ||
  typeof ns.installFetchInterceptor !== "function" ||
  typeof ns.installXhrInterceptor !== "function"
) {
  return
}
const { logBridge, installFetchInterceptor, installXhrInterceptor, installPageSmoother } = ns

if (window.__aegisKillUmpStatus) {
  logBridge(`[Kill UMP] ${window.__aegisKillUmpStatus}`, "INFO")
}

logBridge("AegisStream page-bridge successfully injected into MAIN world")
if (globalThis.AegisSitePolicy?.isReactivePrefetchSite?.()) {
  logBridge(
    "Twitch watch-only mode — native player untouched (no fetch/XHR hooks, prefetch, or cache intercept)",
    "INFO"
  )
  return
}

installFetchInterceptor()
installXhrInterceptor()
if (typeof installPageSmoother === "function") {
  installPageSmoother()
}
})()
