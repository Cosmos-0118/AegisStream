(() => {
var ns = (self.AegisBackground ||= {})

/** ISOLATED-world scripts injected when the tab bridge is (re)installed. */
ns.ISOLATED_CONTENT_FILES = [
  "src/content/execution-guard.js",
  "src/content/relay.js",
  "src/content/smoother/asset-tracker.js"
]

/** MAIN-world scripts for general pages (load order matters). */
ns.MAIN_PAGE_SCRIPT_FILES = [
  "src/page/shared/execution-guard.js",
  "src/page/shared/manifest-mapper.js",
  "src/page/shared/range-buffer.js",
  "src/page/shared/youtube-ump-flags.js",
  "src/page/bridge/core.js",
  "src/page/smoother/shared.js",
  "src/page/smoother/circuit-breaker/timing.js",
  "src/page/smoother/circuit-breaker/asset-breaker.js",
  "src/page/prefetch/buffer-health-monitor.js",
  "src/page/bridge/extension-fetch-client.js",
  "src/page/prefetch/video.js",
  "src/page/bridge/message-bridge.js",
  "src/page/media/youtube/playlist.js",
  "src/page/interceptors/fetch.js",
  "src/page/interceptors/xhr.js",
  "src/page/smoother/navigation/hover-prefetch.js",
  "src/page/smoother/navigation/viewport-preconnect.js",
  "src/page/smoother/install.js",
  "src/page/main.js"
]

/** YouTube-only MAIN-world scripts (before the general bundle on reinject). */
ns.YOUTUBE_MAIN_PAGE_FILES = ["src/page/media/youtube/kill-ump.js"]
})()
