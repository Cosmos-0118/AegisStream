# YouTube support in AegisStream

This document describes how AegisStream handles YouTube playback today: protocol steering, chunk identification, caching, prefetch, and **in-extension fetch racing** for outbound media requests.

## Why YouTube is different

Most sites in AegisStream use **HLS/DASH playlists** (`.m3u8` / `.mpd`). The background parses playlists, schedules segment prefetches, and the page bridge serves cached segments on `fetch`/`XHR` hits.

YouTube’s adaptive stream does **not** follow that path for the main video bytes. The player talks to **`googlevideo.com/videoplayback`** using one of:

| Mode | Transport | Cache identity |
|------|-----------|----------------|
| **Range / sequence (preferred)** | `GET` with `Range`, query `range`/`rbuf`/`sq`, or path `/range/…` `/sq/…` | Normalized byte or sequence key |
| **UMP (fallback)** | `POST` with a binary body (Unified Media Pipeline) | SHA-1 fingerprint of the POST body |

The extension tries to **reduce UMP usage**, then **cache and replay** whatever mode the player actually uses.

---

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  youtube.com (MAIN world, document_start)                               │
│  kill-ump.js → patch ytcfg experiment flags toward range/MSE            │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Page bridge (MAIN world): fetch/XHR interceptors + AegisRangeBuffer    │
│  • Classify videoplayback request → youtubeChunk (bytes | sq | ump)     │
│  • CACHE_LOOKUP → background IndexedDB                                  │
│  • On miss → EXTENSION_FETCH (SW race) → original fetch/XHR fallback    │
│  • On response → tee stream → STORE_CHUNK + heuristic prefetch          │
└─────────────────────────────────────────────────────────────────────────┘
          │ postMessage                    │ chrome.runtime.sendMessage
          ▼                                ▼
┌──────────────────────┐      ┌────────────────────────────────────────────┐
│  relay.js            │      │  background service worker                 │
│  (ISOLATED world)    │─────▶│  cache-db, UMP warmup, telemetry           │
└──────────────────────┘      │  extension-fetch.js (parallel fetch race)  │
                              │  dnr-rules.json (googlevideo headers)      │
                              └────────────────────────────────────────────┘
```

---

## 1. Protocol fallback: `kill-ump.js`

**When:** `document_start`, **MAIN** world, only on `youtube.com` / `*.youtube.com`. Also re-injected by the background when bridging a YouTube tab.

**What:** Patches `window.ytcfg` (and nested configs) to flip experiment flags:

- **Set false:** `web_player_ump`, `web_player_enable_ump`, `web_player_ump_video_proxy`, unified media pipeline flags, `web_player_enable_modern_videoplayback_protocol`
- **Set true:** `html5_disable_media_engine_select_on_ump`, `html5_web_player_vpb_playable_uses_mediasource`

Hooks include `ytcfg` setter, `yt-page-data-updated`, `EXPERIMENT_FLAGS`, `serializedExperimentFlags`, and `ytcfg.set`.

**Goal:** Encourage **MediaSource + byte-range or `sq`** requests so chunks have stable, parseable identifiers. This is best-effort; YouTube may still use UMP.

**Source:** `src/page/media/youtube/kill-ump.js`

---

## 2. Intercepted URLs and chunk types

### Detection

- **Video bytes:** `isYoutubeVideoPlaybackUrl` — URL matches `googlevideo.com/videoplayback`
- **Also treated as a “chunk” URL:** same pattern inside `isLikelyChunk()` for generic logic

### Range / sequence parsing (`AegisRangeBuffer`)

Implemented in `src/page/shared/range-buffer.js`, used from `src/page/media/youtube/playlist.js`.

Parsing order:

1. `Range` request header (`bytes=start-end`)
2. Query: `range`, `rbuf`, `sq`
3. Path: `/range/{start}-{end}`, `/sq/{n}`

| `type` | Meaning |
|--------|---------|
| `bytes` | Byte-range segment |
| `sq` | Sequence index (next segment = `sq + 1`) |

### Stream ID (`getStreamId`)

Strips volatile query params (`range`, `rn`, `rbuf`, `sq`, `alr`) and path tokens (`/range/…`, `/sq/…`, `/rn/…`) so one logical stream shares one ID across requests.

### Cache keys

| Type | Key format |
|------|------------|
| Range / sq | `range\|{streamId}\|{start}-{end}` |
| UMP POST | `ump\|{streamId}\|{bodyHash16}` |

UMP `bodyHash` = first 16 hex chars of **SHA-1** of the POST body (`buildYoutubeUmpState`).

---

## 3. Page bridge: `fetch` and `XHR`

### `fetch` (`src/page/interceptors/fetch.js`)

**Intercept when:**

- `GET` and URL is a likely chunk **or** a parsed `youtubeChunk`
- `POST` and `youtubeChunk.type === "ump"`

**Skip intercept when:** `Range` header present but range parsing failed (avoid wrong keys).

**Flow:**

1. Build `youtubeChunk` (range/sq from URL/headers; UMP from POST body hash).
2. `CACHE_LOOKUP_REQUEST` with synthetic `cacheLookupUrl` (UMP lookups use method `GET` in the message only).
3. **Cache hit:** return `Response` — `206` + `Content-Range` for `bytes`, `200` for UMP/full.
4. **Cache miss:** **`EXTENSION_FETCH_REQUEST`** first (service worker), then `originalFetch` on failure.
5. **Store:** tee response body (or UMP proxy stream); `STORE_CHUNK_REQUEST` to background.

**UMP-specific:** `createUmpProxyResponseAndCache` — passthrough `ReadableStream` that buffers the response (max **20 MB** per capture, max **2** concurrent captures), then stores when the stream completes. Aborts/errors are treated as normal UMP recycling.

**Recovery:** If no chunk was parsed but response is `206`, recover range from `Content-Range` and cache under the correct key.

### `XHR` (`src/page/interceptors/xhr.js`)

Same ideas for **GET** videoplayback:

- Cache-first with synthetic `readyState === 4` and fake headers
- On network `load`, store bytes and call `triggerHeuristicPrefetch`

**UMP POST is handled on `fetch` only** — XHR does not call `buildYoutubeUmpState`.

---

## 4. Heuristic prefetch (range / sq only)

After a **non-UMP** chunk is stored (`range-buffer.js` / background cache path):

1. Compute **next** URL via `buildNextRangeUrl` (increment range or `sq`, bump `rn` if present).
2. At most **2** concurrent prefetches (`MAX_HEURISTIC_PREFETCHES`).
3. Fetch next segment with page `fetch`; on **401/403**, retry with `credentials: "include"`.
4. If page fetch fails, **`EXTENSION_FETCH_REQUEST`** fallback (same as main miss path).
5. Store under `range|{streamId}|…` and notify background via `PREFETCH_RESULT`.

UMP mode does not have a stable “next URL” — replay depends on the same POST body hash.

**Cache key:** `ump|id:<video>;itag:<n>;cpn:<session>|bodyHash` (not the full signed `googlevideo` URL). A secondary alias `ump|<bodyHash>` is written so replays still resolve after URL signature rotation.

### Anti-buffering roadmap (engineering priorities)

| Idea | Verdict | Status |
|------|---------|--------|
| Predict UMP POST bodies | Kill — telemetry in body, high maintenance | Not built |
| Buffer-aware prefetch (`video.buffered`) | Keep — modulates window/concurrency by runway | **Implemented** |
| Kill UMP / force byte-range MSE | Holy grail — unlocks range prefetch | **Expanded** (`youtube-ump-flags.js`, `youtubei` API patch) |
| Cross-tab session cache | Refine — UX on HLS replay | IndexedDB only (no UMP cross-session) |

**Buffer policy (health score):** samples every **750ms**; combines runway (55%), net fill rate (35%), and recent stall penalty. Tiers: **emergency** (&lt;5s), **aggressive** (5–15s), **normal** (15–30s), **maintenance** (30–60s, 1 worker keeps cache warm), **idle** (60s+, 1 worker monitors). Never fully sleeps prefetch — maintenance mode avoids the “network died while sleeping” trap.

---

## 5. Extension fetch engine (service worker)

YouTube segment URLs are often **signed** and **cookie-bound**. Page-world `fetch` from the bridge can fail (403) even when a normal tab request would succeed.

AegisStream runs outbound media fetches in the **service worker** using parallel browser `fetch` paths — no native host install.

### Components

| Piece | Role |
|-------|------|
| `src/background/network/extension-fetch.js` | `raceExtensionFetch()`, `pumpResponseBody()` (256 KB chunks) |
| `src/background/config/dnr-rules.json` | DNR rules: Origin/Referer for `googlevideo.com/videoplayback` |
| `src/background/messaging/message-router.js` | Extension fetch handler — streams body to tab via `ExtensionFetchChunk` / `End` |
| `src/content/relay.js` | Relays fetch request + chunk/end messages to MAIN world |
| `src/page/bridge/extension-fetch-client.js` | `requestExtensionFetchStream()` (player) / `requestExtensionFetchBuffered()` (prefetch) |

**Manifest:** `declarativeNetRequest` + `declarativeNetRequestWithHostAccess` (no `nativeMessaging`).

### Racing logic (`raceExtensionFetch`)

For **GET/HEAD** segment fetches:

1. Fire two parallel `fetch` calls: `credentials: "include"` (high priority) vs `credentials: "omit"` (low priority).
2. `Promise.race` on the first completion; abort the slower request.
3. On failure, fall back to a single `credentials: "include"` fetch.

For **POST** (UMP replay), a single `credentials: "include"` fetch is used (body must match the player).

Timeout: **65s** per request.

### Page ↔ background flow (chunked stream)

```
Player request → bridge intercept → cache miss
  → EXTENSION_FETCH_REQUEST (requestId) → content relay → service worker
  → raceExtensionFetch → pumpResponseBody (256 KB chunks, base64 over tabs.sendMessage)
  → EXTENSION_FETCH_RESPONSE { streaming, status, headers }
  → EXTENSION_FETCH_CHUNK × N → EXTENSION_FETCH_END
  → ReadableStream → synthetic Response to player
  → (parallel) tee/cache STORE_CHUNK
```

Prefetch and range-buffer heuristic use the same transport but **buffer once** in the page before `STORE_CHUNK`.

On extension fetch failure, the bridge falls back to **`originalFetch`** / normal XHR.

---

## 6. Background cache and UMP policy

Chunks are stored in **IndexedDB** via `STORE_CHUNK_REQUEST` (`src/background/cache/db.js`).

**Store rules (simplified):** `GET`-oriented keys, no `hasRange` flag on stored entries, status not `206` at store time (stored as full objects keyed by synthetic URL).

**UMP lookups** (`ump|…` keys):

- **Warmup:** first lookups on a new UMP key may intentionally miss while `youtubeUmpLookups ≤ UMP_WARMUP_LOOKUP_LIMIT` (6) and no hits yet — avoids serving stale data before the first capture completes.
- Telemetry tracks requests, lookups, hits/misses, warmups, stream outcomes (completed, aborted, error, truncated, capture_skipped).

**Popup:** shows **“Active (YouTube realtime mode)”** when there are UMP requests but zero HLS playlists detected — UMP is not “broken cache,” it is a different operating mode.

Constants: `src/background/config/constants.js` (`UMP_WARMUP_LOOKUP_LIMIT`, `UMP_HEALTH_LOG_INTERVAL_MS`, etc.).

---

## 7. Telemetry

YouTube-specific metrics (bridge → background):

| Metric | Meaning |
|--------|---------|
| `youtube_ump_request` | UMP POST intercepted (body hash, length) |
| `youtube_ump_stream_outcome` | Proxy stream end state (completed, aborted, error, truncated, capture_skipped, store_failed) |
| `request_first_byte` | Cache vs network TTFB by `streamType` (`bytes`, `sq`, `ump`, `generic`) |

Aggregated in popup stats and throttled health logs (`telemetry.js`).

---

## 8. Operating modes (summary)

| Mode | YouTube behavior | Cache key | Prefetch | Extension fetch |
|------|------------------|-----------|----------|-----------------|
| **Range/sq** | GET + identifiable range/sq | `range\|streamId\|…` | Yes — next range/sq | Miss path + prefetch fallback |
| **UMP** | POST + binary body | `ump\|streamId\|hash` | No URL-based next segment | Miss path for POST replay; stream capture up to 20 MB |

---

## 9. Limitations

- **DRM** is not bypassed; encrypted paths stay out of scope.
- **`kill-ump`** does not guarantee range mode — UMP may still win.
- Players that **bypass** patched `fetch`/`XHR` are not fully covered.
- **UMP cache** is body-hash keyed — identical replay only when the player sends the same POST body.
- **DNR header rules** apply to `googlevideo.com` only; other CDNs rely on normal extension `fetch` credentials.

---

## 10. Source file map

| File | Responsibility |
|------|----------------|
| `src/page/media/youtube/kill-ump.js` | YouTube experiment flag patching |
| `src/page/shared/range-buffer.js` | Parse range/sq, stream ID, cache keys, heuristic prefetch |
| `src/page/media/youtube/playlist.js` | UMP state, proxy+cache, chunk helpers, playlist sniffing |
| `src/page/interceptors/fetch.js` | Main intercept, extension fetch miss path, UMP streaming |
| `src/page/interceptors/xhr.js` | GET videoplayback, XHR cache serve |
| `src/content/relay.js` | Page ↔ background relay (including extension fetch) |
| `src/background/network/extension-fetch.js` | Service worker fetch + race |
| `src/background/messaging/message-router.js` | Cache lookup/store and extension fetch routing |
| `src/background/config/dnr-rules.json` | YouTube googlevideo header injection |

---

## Related reading

- [README.md](../README.md) — project overview and local load instructions
- [ROADMAP.md](./ROADMAP.md) — planned improvements (if present)
