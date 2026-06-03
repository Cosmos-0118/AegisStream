importScripts(
  "./config/constants.js",
  "./state/runtime-state.js",
  "./injection/url-policy.js",
  "./media/serializers.js",
  "./media/cache-keys.js",
  "./media/manifest-mapper.js",
  "./media/url-classifiers.js",
  "./media/site-policy.js",
  "./media/twitch-session.js",
  "./parsing/playlists.js",
  "./cache/db.js",
  "./cache/store-queue.js",
  "./telemetry/activity-metrics.js",
  "./telemetry/extension-fetch-metrics.js",
  "./telemetry/worker-lifecycle.js",
  "./telemetry/runtime-metrics.js",
  "./prefetch/tab-policy.js",
  "./prefetch/buffer-policy.js",
  "./prefetch/orchestrator.js",
  "./network/extension-fetch.js",
  "./network/html-head-scanner.js",
  "./network/stream-injector.js",
  "./smoother/telemetry-defuser.js",
  "./smoother/bfcache-healer-registry.js",
  "./smoother/performance-coordinator.js",
  "./network/document-stream-hook.js",
  "./smoother/layout-asset-store.js",
  "./smoother/header-injector.js",
  "./lifecycle/page-scripts.js",
  "./lifecycle/tab-bridge.js",
  "./lifecycle/chrome-events.js",
  "./messaging/message-router.js"
)

// Lifecycle: no top-level init. Engine state wakes on demand; tab bootstrap runs only on install.
const {
  registerChromeEventListeners,
  registerMessageRouter,
  recordServiceWorkerActivation
} = self.AegisBackground

void recordServiceWorkerActivation()
registerChromeEventListeners()
registerMessageRouter()
