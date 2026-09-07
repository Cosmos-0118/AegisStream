# AegisStream

Adaptive media + web-page acceleration for Chromium (MV3, v0.4.0).

AegisStream has two pillars:

1. **Media Acceleration** — detects HLS/DASH playback, prefetches upcoming segments ahead of the playhead, and serves them from local cache when the player stalls or the network jitters.
2. **Page Accelerator ("Smoother")** — faster navigation and first paint on everyday sites: hover-prefetch, viewport preconnect, learned layout preloads (HTTP `Link` early hints + HTML stream injection), CPU-shield telemetry defusing, and BFcache freeze-thaw healing.

No native host required. All media fetches run inside the extension service worker.

> DRM-protected streams are never bypassed. Signed URLs, strict anti-bot pages, and native (non-fetch/XHR) players limit what prefetch can do, and the extension fails gracefully there.

## How it works

### Media pipeline (background service worker + page bridge)

- **Detection:** `fetch` + `XHR` interceptors (MAIN world) observe playlists (`.m3u8`/`.mpd`, obfuscated CDN blobs, pattern-addressed ladders) and segment requests. Master playlists are scanned (up to 6 variants); media playlists are refreshed on a debounced schedule with retry budget and rotation/episode-transition guards.
- **Anchor authority:** playback position is reconciled from DOM (`currentTime`/`seeked`), seek prediction (Kalman + Gaussian macro predictor), and network observations, with teleport/scrub detection, hysteresis, and dwell checks.
- **Prefetch lanes (bounded concurrency):**
  - Urgent window (default 6 ahead, max 20) in strict playback order.
  - **Rescue lane** when runway < ~3s or health collapses — preempts with the next 2 segments.
  - **Depth lane** fills up to ~180s / 120 segments ahead (max 50% of cache) once runway is comfortable (>15s).
  - **Speculative multi-rung** prefetches adjacent quality rungs when runway is high; adaptive full/minimal/off modes driven by observed hit rate.
  - **Seek/scrub handling:** seek prediction, scrubbing-train ring (±2–3), snap-back fill (±15) on slider release.
- **Arbitration:** congestion controller, stream arbitrator, speculation arbitrator, network-panic mode (widens window to 20, targets 450s runway when p95 TTFB > 3s), per-tab burst caps, idle/hidden-tab throttling, auth-failure backoff.
- **Serving:** page-bridge cache lookup → hot in-memory byte cache → IndexedDB → collapsed wait on in-flight prefetch/store → network fallback. Request coalescing dedupes duplicate in-flight fetches; byte-range requests are supported.
- **Cache:** IndexedDB `aegisstream-cache` v3 (`chunks` + `aliases` stores, default 2,000 entries, 96 MB–4 GB adaptive budget). Guard-ring (protects ±past/future of playhead), timeline-heat scoring, scrub/seek-churn suppression, eviction journal (evict-then-miss accounting), rotation-alias purge, TTL sweeps, write queue with backpressure (concurrency 4, depth 256), CRC/invariant dedup.
- **Robustness:** signed-URL rotation (prior-URL history depth 4, idle-stale recapture at 120s, visibility recapture at 30s), manifest relay TTL, per-URL failure cooldowns with exponential backoff, warm-recovery snapshots in `chrome.storage.session` (survives SW restart without locking onto low-quality startup rungs), worker-liveliness pings.
- **Site policy:** Twitch watch-only (native player untouched), YouTube/googlevideo/Blogger embed passthrough, reactive-prefetch blocklists; passive browse mode defers media interceptors until a playback context appears.

### Page Accelerator

| Feature | What it does | Toggle |
|---|---|---|
| Hover-prefetch + viewport preconnect | Prefetch likely next navigations; preconnect in-viewport origins | always-on |
| Layout-asset store | Learns per-path critical assets, merges SPA layouts | always-on |
| Header Early Hints | Appends compression-safe `Link` preload headers from layout cache (DNR) | `headerEarlyHints` |
| HTML Stream Boost | Injects learned preloads into uncompressed HTML responses | `documentStreamBoost` |
| Telemetry Defuser (CPU Shield) | Blocks session-replay scripts, installs deep no-op analytics proxies (DNR + MAIN-world mocks) | `cpuShieldEnabled` |
| Aggressive Script Defuser (Experimental) | Also defuses Mixpanel/GA/Segment SDKs | `aggressiveScriptDefuserEnabled` |
| BFcache Freeze-Thaw Healer | Parks WebSockets/EventSources cleanly, re-hydrates on back/forward restore | `bfcacheEnforcerEnabled` |

A background performance coordinator keeps the pipelines in sync. All page work respects an adaptive circuit breaker.

### Contexts

- `src/background/` — MV3 service worker (importScripts, wakes on demand; tab bootstrap on install only): `config/`, `state/`, `media/`, `cache/`, `network/`, `prefetch/{core,policy,anchor,playlist,scheduler,seek,scrub,lanes,arbitration,state,wire}`, `telemetry/{collectors,domains,observability}`, `smoother/`, `lifecycle/`, `messaging/`.
- `src/page/` (MAIN world, `document_start`, all frames) — `core/` guard + site policy, `interceptors/` fetch/XHR, `bridge/` plumbing + extension-fetch client, `cache/` registry + hot bytes + response headers, `network/` coalescer, `prefetch/` buffer health + delegated video prefetch + seek predictor, `playback/` video monitor + seeking controller + Kalman filter, `media/` manifest mapping + HLS/DASH classification, `smoother/` navigation + circuit breaker + CPU mocks, `main.js` installer.
- `src/content/` (ISOLATED world) — relay + asset tracker + execution guard; bridges MAIN-world page scripts to the service worker.
- `src/shared/media-cache-key.js` — invariant cache-key logic shared by both worlds (volatile query-param stripping, tail fingerprinting).
- `src/popup/` — Dashboard / Performance / Logs UI with 4 themes (Obsidian default, Aurora, Paper, Ember).

## Popup

- **Dashboard → Controls:** Enable Extension (master), Proactive Prefetch, Speculative Multi-Rung Prefetch, Serve From Cache, Prefetch Window (1–20, default 6).
- **Dashboard → Activity:** Serve Hit Rate hero (last 5 min) + Reset / Clear Cache; 6 counters (Cache Hits, Lookup Misses, In Cache Now, Failures, Playlists, Segments Req.); **System Health** (Lookups, Warmups, Runway, Cache Filled, TTFB P95, Stalls, Evict. Suppressed, Consumer Saved); **Speculative Prefetch** (bytes hit rate, used/completed, consumed/downloaded, switch hits + full/minimal mode badge).
- **Performance tab:** Page Accelerator pipeline status + BFcache Healer, HTML Stream Boost, Header Early Hints, Telemetry Defuser, Aggressive Defuser (experimental, requires CPU Shield).
- **Logs tab:** level-aware system logs (2,000-entry ring) with Clear / Copy All, polled every 1.5s.

## Install (Chrome / Edge)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (`AegisStream`).
3. Open the toolbar popup, verify status dot is **Active**, tune Dashboard/Performance toggles.

Permissions used: `storage`, `unlimitedStorage`, `webRequest`, `tabs`, `scripting`, `declarativeNetRequest` (+ `WithHostAccess`), `browsingData`, `<all_urls>` (media + smoother need full-host access; 3 DNR rule sets: 1 media ruleset enabled, 2 defuser sets toggled by settings).

## Validate quickly

1. Open a public **non-DRM** HLS page, start playback.
2. Watch popup **Activity**: `In Cache Now` should climb, `Serve Hit Rate` > 0%, `Segments Req.` increasing.
3. DevTools → Network → throttle to Slow 4G / offline-blip; stalls should be shorter with extension on vs. off.
4. **Logs** tab shows playlist detection, prefetch scheduling, hit/store lines; `Clear Cache` between runs.

## Tests

- 94 unit tests under `test/`, mirroring `src/` (`background/{media,cache,prefetch,telemetry,network,messaging}`, `page/{bridge,cache,interceptors,media,network,prefetch,playback,smoother,core}`, `shared/`, `popup/themes`).
- No `package.json` / runner — run per file with Node:
  ```sh
  node test/background/cache/store-queue.test.js
  node test/popup/themes.test.js
  ```
  Most tests are dependency-free (`node:assert` + `vm` sandbox loading of `src/` files).

## Project layout

```
manifest.json                  MV3 declaration (v0.4.0), permissions, DNR sets, content scripts
icons/                         toolbar icons
src/background/service-worker.js  thin entry: importScripts + register listeners only
src/background/{config,state,media,cache,network,prefetch,telemetry,smoother,lifecycle,messaging}/
src/page/{core,cache,network,bridge,prefetch,playback,interceptors,media,smoother,main.js}
src/content/                   ISOLATED-world relay + asset tracker
src/shared/                    cross-world cache-key helpers
src/popup/{popup.html,popup.js,themes/,styles/}
test/                          94 *.test.js mirroring src/
```

## Constraints & known limits

- DRM streams are out of scope by design.
- Players using MSE `SourceBuffer` appends over native/UMP stacks, blob URLs, or Range-locked CDNs may prefetch but not always serve — hits vary by site.
- Signed/expiring URLs rotate; the extension recaptures playlists but cannot extend a CDN's auth window.
- MV3 service workers are ephemeral — warm-recovery snapshots rebuild state, but a cold restart mid-playback briefly pauses prefetch.
