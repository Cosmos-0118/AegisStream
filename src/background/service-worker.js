importScripts(
  "./config/constants.js",
  "./state/runtime-state.js",
  "./telemetry/collectors/activity-metrics.js",
  "./network/url-policy.js",
  "./media/serializers.js",
  "../shared/media-cache-key.js",
  "./media/cache-keys.js",
  "./media/manifest-mapper.js",
  "./media/manifest-fetch-coalescer.js",
  "./media/playlist-matrix.js",
  "./media/url-classifiers.js",
  "./media/site-policy.js",
  "./media/twitch-session.js",
  "./parsing/playlists.js",
  "./cache/timeline-heat.js",
  "./cache/guard-ring.js",
  "./cache/eviction-journal.js",
  "./cache/db.js",
  "./cache/cache-registry.js",
  "./cache/store-queue.js",
  "./telemetry/collectors/metrics-collector.js",
  "./telemetry/domains/seek-prediction-telemetry.js",
  "./telemetry/observability/decision-observability.js",
  "./telemetry/collectors/metrics-aggregator.js",
  "./telemetry/collectors/inflight-accounting.js",
  "./prefetch/state/inflight-consumers.js",
  "./telemetry/domains/rescue-telemetry.js",
  "./telemetry/domains/anchor-telemetry.js",
  "./telemetry/domains/episode-transition-telemetry.js",
  "./telemetry/domains/extension-fetch-metrics.js",
  "./telemetry/observability/worker-lifecycle.js",
  "./telemetry/collectors/runtime-metrics.js",
  "./telemetry/domains/speculative-telemetry.js",
  "./prefetch/policy/tab-policy.js",
  "./prefetch/policy/network-panic-policy.js",
  "./prefetch/arbitration/congestion-controller.js",
  "./prefetch/lanes/rescue-lane.js",
  "./prefetch/arbitration/stream-arbitrator.js",
  "./prefetch/policy/prefetch-lane-policy.js",
  "./prefetch/policy/buffer-policy.js",
  "./prefetch/state/playback-state-machine.js",
  "./prefetch/anchor/anchor-hysteresis.js",
  "./prefetch/anchor/anchor-authority.js",
  "./prefetch/anchor/anchor-reconciler.js",
  "./prefetch/wire/prefetch-failure-log.js",
  "./prefetch/state/network-generation.js",
  "./prefetch/wire/unified-seek-wire.js",
  "./prefetch/arbitration/orchestrator.js",
  "./cache/eviction-manager.js",
  "./prefetch/arbitration/speculation-arbitrator.js",
  "./prefetch/lanes/speculative-prefetch.js",
  "./network/fetch-priority.js",
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
if (typeof self.AegisBackground.startLane3ReconcileLoop === "function") {
  self.AegisBackground.startLane3ReconcileLoop()
}
if (typeof self.AegisBackground.startMetricsAggregatorRollup === "function") {
  self.AegisBackground.startMetricsAggregatorRollup()
}
registerChromeEventListeners()
registerMessageRouter()
