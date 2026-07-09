(() => {
// orchestrator.js — thin entry point
// All orchestration logic has been split into focused modules under prefetch/:
//   core/, playlist/, scrub/, seek/, scheduler/, anchor/
//
// Each module assigns functions to self.AegisBackground via IIFE.
// This file exists only as a load-order anchor in service-worker.js importScripts.
// Module dependencies:
//   core/constants → anchor-utils → scrub-utils/state-utils → anchor-manager/manifest-refresh → ...rest
//   (order enforced by service-worker.js import list)
//
// Cross-module references (callable after all loads):
//   - anchor-utils: ns.isTabInScrubbingTrain needs ns.isScrubbingTrainActive
//   - anchor-manager: ns.markSeekChurnAggressive (scrub-utils), ns.enterTeleportMode (self)
//   - scrub-handler: ns.schedulePrefetch (prefetch-scheduler)
//   - manifest-refresh: ns.executeManifestRefreshAttempt, ns.parseAndPrefetchFromPlaylist (playlist-fetcher)
//   - prefetch-scheduler: ns.delegatePrefetchToPage (page-delegate)
//   - chunk-observer: ns.handleChunkObserved calls into anchor-manager, scrub-utils
var ns = (self.AegisBackground ||= {})
if (!ns.schedulePrefetch || !ns.handleChunkObserved || !ns.handleUnifiedSeekState) {
  console.warn("Aegis background: orchestrator modules may not be fully loaded")
}
})()
