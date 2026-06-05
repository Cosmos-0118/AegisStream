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

function activateMediaBridge(reason = "startup") {
  if (ns.mediaBridgeActive === true) return true
  ns.mediaBridgeActive = true
  installFetchInterceptor()
  installXhrInterceptor()
  if (typeof ns.startBufferHealthMonitor === "function") {
    ns.startBufferHealthMonitor()
  }
  logBridge(`Media bridge activated (${reason})`, "DEBUG")
  return true
}

ns.activateMediaBridge = activateMediaBridge
ns.isMediaBridgeActive = () => ns.mediaBridgeActive === true

if (typeof installPageSmoother === "function") {
  installPageSmoother()
}

if (globalThis.AegisSitePolicy?.shouldRunMediaBridge?.()) {
  activateMediaBridge("media-host")
} else {
  logBridge("Passive browse mode — media interceptors deferred until playback context", "DEBUG")
}
})()
