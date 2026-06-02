(() => {
var ns = (self.AegisPageBridge ||= {})
if (ns.__bridgeInstalled === true) return
if (
  typeof ns.logBridge !== "function" ||
  typeof ns.installFetchInterceptor !== "function" ||
  typeof ns.installXhrInterceptor !== "function"
) {
  return
}
ns.__bridgeInstalled = true
const { logBridge, installFetchInterceptor, installXhrInterceptor } = ns

if (window.__aegisKillUmpStatus) {
  logBridge(`[Kill UMP] ${window.__aegisKillUmpStatus}`, "INFO")
}

logBridge("AegisStream page-bridge successfully injected into MAIN world")

installFetchInterceptor()
installXhrInterceptor()
})()
