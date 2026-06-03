# AegisStream Extension

AegisStream is a browser extension that reduces video buffering by prefetching upcoming media chunks and serving cached data when players hit jitter or request delays.

## Goal

Build a resilient, site-agnostic buffering shield for non-DRM HLS/DASH playback while respecting DRM boundaries and failing gracefully on incompatible players.

## What works now

- **Page smoother:** hover-prefetch + DNR session `Link` header early hints (Brotli/gzip-safe), layout asset learning, viewport preconnect, adaptive circuit breaker, optional uncompressed HTML stream fallback, CPU shield (DNR mock scripts), BFcache enforcer.
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
- `src/worker/background.js` - service-worker entrypoint wiring orchestration, caching, telemetry, and extension fetch IO.
- `src/worker/background/io/extension-fetch.js` - parallel `fetch` racing in the service worker (replaces native daemon).
- `src/worker/background/config/dnr-rules.json` - DNR header rules for `googlevideo.com` background fetches.
- `src/worker/background/` - background modules grouped by `config`, `state`, `domain`, `io`, and `orchestration`.
- `src/content/` - isolated-world relay, page smoother modules (`smoother/`), and YouTube-specific main-world bootstrap scripts.
- `src/bridge/` - page-world bridge modules split into `runtime`, `interceptors`, `domain`, and shared primitives.
- `src/popup/popup.html` / `src/popup/popup.js` - popup UI controls and diagnostics.
- `docs/ROADMAP.md` - detailed build and rollout roadmap.
- `docs/idea.md` - revised architecture direction and success criteria.

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
