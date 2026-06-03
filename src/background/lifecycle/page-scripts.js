(() => {
var ns = (self.AegisBackground ||= {})

/** ISOLATED-world scripts injected when the tab bridge is (re)installed. */
ns.ISOLATED_CONTENT_FILES = [
  "src/content/execution-guard.js",
  "src/content/relay.js",
  "src/content/asset-tracker.js"
]

/** MAIN-world scripts for general pages (load order matters). */
ns.MAIN_PAGE_SCRIPT_FILES = [
  "src/page/core/execution-guard.js",
  "src/page/media/manifest-mapper.js",
  "src/page/core/site-policy.js",
  "src/page/cache/cache-response-headers.js",
  "src/page/cache/range-buffer.js",
  "src/page/media/youtube/youtube-ump-flags.js",
  "src/page/bridge/core.js",
  "src/page/media/media-cache-key-page.js",
  "src/page/network/network-fetch-coalescer.js",
  "src/page/cache/cache-registry.js",
  "src/page/smoother/shared.js",
  "src/page/smoother/circuit-breaker/timing.js",
  "src/page/smoother/circuit-breaker/asset-breaker.js",
  "src/page/prefetch/buffer-health-monitor.js",
  "src/page/prefetch/prefetch-failure.js",
  "src/page/prefetch/seek-predictor.js",
  "src/page/media/kalman-segment-filter.js",
  "src/page/media/seeking-controller.js",
  "src/page/media/video-monitor.js",
  "src/page/bridge/extension-fetch-client.js",
  "src/page/prefetch/video.js",
  "src/page/bridge/message-bridge.js",
  "src/page/media/youtube/playlist.js",
  "src/page/media/youtube/cross-itag-predictor.js",
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
