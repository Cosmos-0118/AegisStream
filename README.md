# AegisStream Extension

AegisStream is a browser extension that reduces video buffering by prefetching upcoming media chunks and serving cached data when players hit jitter or request delays.

## Goal

Build a resilient, site-agnostic buffering shield for non-DRM HLS/DASH playback while respecting DRM boundaries and failing gracefully on incompatible players.

## What works now

- **Page smoother:** hover-prefetch + path-aware DNR `Link` header hints (gzip/br safe), SPA layout learning with merge, viewport preconnect, adaptive circuit breaker, optional uncompressed HTML stream fallback, CPU shield (DNR script defuse + universal deep no-op proxy at `document_start`), optional aggressive defuser toggle, BFcache freeze-thaw healer (unload→pagehide migration + WebSocket/EventSource re-hydration), background performance coordinator syncing pipelines in parallel.
- Detects likely HLS/DASH playlists and media chunks.
- Parses HLS media playlists and follows master playlist variants.
- Prefetches upcoming chunks with bounded concurrency.
- Deduplicates in-flight prefetches and cooldowns repeated failures.
- Stores chunks in IndexedDB with FIFO eviction by entry limit.
- Serves cached responses through a page-context `fetch` bridge.
- Exposes popup controls, live stats, and one-click cache clear.

## Constraints

- DRM-protected streams are not bypassed.
- Not all players use `fetch` (some use XHR/native stack), so compatibility varies.
- Signed URLs and strict anti-bot controls can limit prefetch effectiveness.
- Extension service workers are ephemeral; state rebuilding is expected.

## Project layout

- `manifest.json` - extension declaration and permissions.
- `src/background/service-worker.js` - thin entry: registers listeners only (no top-level init). Engine state wakes on demand; tab bootstrap runs on install only.
- `src/background/` - service worker by responsibility:
  - `config/` - constants and DNR rule JSON
  - `state/` - runtime settings and in-memory state
  - `media/` - URL normalization, cache keys, serializers
  - `parsing/` - HLS/DASH playlist parsing
  - `cache/` - IndexedDB storage and write queue
  - `network/` - extension fetch, injection URL policy, HTML stream injection, head scanner
  - `prefetch/` - scheduling domain (`policy/`, `anchor/`, `lanes/`, `arbitration/`, `state/`, `wire/`)
  - `telemetry/` - metrics (`collectors/`), event streams (`domains/`), debug hooks (`observability/`)
  - `smoother/` - layout assets, header hints, CPU defuse, BFCache healer
  - `lifecycle/` - page script manifest, engine wake vs install bootstrap, tab bridge, Chrome events
  - `messaging/` - `runtime.onMessage` handlers
  - `src/page/` - MAIN-world page scripts:
  - `core/` - execution guard and site policy
  - `cache/` - chunk registry, response headers, range buffer
  - `network/` - in-page fetch coalescing
  - `bridge/` - intercept plumbing, message bridge, extension fetch client
  - `prefetch/` - buffer health and delegated video prefetch
  - `interceptors/` - `fetch` and `XHR` hooks
  - `media/` - manifest mapping, HLS/DASH chunk classification, cache keys, playback helpers
  - `smoother/` - navigation hints, circuit breaker, CPU mock scripts (`mock/`), `install.js`
  - `main.js` - installs interceptors and smoother after dependencies load
- `src/content/` - ISOLATED-world relay and asset tracker.
- `src/shared/` - cache key helpers used by background and page contexts.
- `src/popup/` - popup UI controls and diagnostics.
- `test/` - unit tests mirroring `src/` layout (run with `node test/...`).

## Run locally (Chrome/Edge)

1. Open `chrome://extensions`.
2. Enable Developer Mode.
3. Click "Load unpacked".
4. Select this folder (`AegisStream`).
5. Open popup and enable prefetch/cache.

No native host install is required — all media fetches run inside the extension service worker.

## Validate quickly

1. Open a public non-DRM HLS page and start playback.
2. Watch popup counters (`hits`, `misses`, `prefetched`, `failures`).
3. Apply network throttling and compare stall behavior with extension on/off.
4. Clear cache from popup between test runs.

## Next development targets

- Adaptive prefetch window tuning.
- Live-playlist drift handling.
- Byte-range/XHR compatibility improvements.
- Parser and scheduler unit tests.
