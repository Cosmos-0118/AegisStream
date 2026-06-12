# Hit Rate Investigation — 2026-06-12 (Pass 3)

Cross-reference of **baseline log** (`logs/log.txt`, pre-fix scrub session on `swiftstream.top`) against the **current codebase** after Pass 2 (IPC/delivery) and Pass 3 (timing/coordination) fix batches.

---

## Executive summary

| | Baseline (pre-fix log) | After Pass 2 | After Pass 3 (current code) |
|--|------------------------|--------------|-----------------------------|
| **BG hit rate** | 57% (25/44) | ~57% when IDB has data | ~57%+; warm path faster via memory key index |
| **Effective page hit rate** | ~0–15% (collapse/wire only) | Target: within ~10 pts of BG | **Projected 50–70%** on aggressive scrub |
| **`network-native` writebacks** | ~16 re-downloads of known CRCs | Should drop sharply | Further reduced: demand-start + wire-first collapse |
| **Rescue aborts** | 13 aborts / 11 activations in 20s | Cooldown softens re-arms | Scoped keep-window + relay `keepUrls` fix |
| **Scrub prefetch targeting** | Anchor stuck at 0, player at 8 | Still drift-prone | Weighted-median reconciliation after 500ms dwell |
| **Registry false negatives** | `not-candidate` killed reuse | Belt helped | Trust decay + false-negative suspension |
| **System rating** | **4 / 10** | **7 / 10** | **8 / 10** (pending validation log) |

**Bottom line:** Pass 2 fixed the **phantom-hit** failure mode (BG found bytes, page never received them). Pass 3 fixed the **coordination** failure mode (predictor, prefetch, lookup, and rescue were racing each other). Most remaining misses in the baseline log were timing/coordination — not true cache absence. The one major gap still open is **cache byte pressure / eviction churn** under long sessions (P7 deferred; log only reached ~13 chunks).

> `logs/log.txt` is still the **pre-fix** capture. A fresh scrub log is the only thing standing between **8/10 (code-complete)** and a confirmed production rating.

---

## Baseline session snapshot (health line @ 18:06:30)

```
lookups=44, hits=25, miss=19, hitRate=57%        # BG-only metric in old log format
stalls=8 (16.0s)
seekPred hitRate=33%, meanError=7, p95Error=9
rescue(act=11, aborts=13, delegated=26, genBump=23)
writebackSuppressed=27
stores(ok=72, prefetch=54, xhr-sync=18, avgKB=2191.9)
anchor(net=79/pred=0/dom=9, teleport hard=0/soft=9, deferred=4)
```

New health line format (post-fix) exposes the delivery gap explicitly:

```
bgHitRate=57%, pageDelivered=N, pageHitRate=M%
```

After Fix 1, `pageHitRate` should track `bgHitRate` within a few points.

---

## Root cause (baseline) — phantom cache hits

Dominant pattern in the baseline log:

```
[INFO] Cache HIT: … (2183996 bytes, crc=90CD5951)
[DEBUG] [CACHE-LOOKUP] response ok=false hit=false key=…
[DEBUG] [CACHE-LOOKUP-BELT] miss lane=lookup-miss …
[INFO] [WRITEBACK-COMMITTED] source=network-native bytes=2183996 …
[INFO] StoreChunk accepted: source=xhr-sync … bytes=2183996
```

BG logged **25** `Cache HIT` lines; page logged **zero** `ok=true hit=true` lookup responses. One `Cache HIT via collapse` (line 433) shows wire-collapse still worked occasionally.

**Mechanism:** `chrome.runtime.sendMessage` often neutered the raw `ArrayBuffer` on the BG→content→page path. Store used base64; lookup did not. Relay downgraded to `{ ok: false, hit: false, error: "cache-bytes-unavailable" }` while BG metrics still counted a hit.

---

## Fixes shipped (verified in code)

### ✅ P0 — Base64 parity for CACHE_LOOKUP responses

| File | Change |
|------|--------|
| `src/background/messaging/message-router.js` | `handleCacheLookup` attaches `bytesBase64` alongside raw `bytes` via `arrayBufferToBase64()` |
| `src/content/relay.js` | On hit: try `copyArrayBuffer`; on failure fall through to `bytesBase64`; also handles hit-with-only-base64 |
| `src/page/bridge/core.js` | `resolveLookupBytes()` already decodes `bytesBase64` |

**Status:** Shipped. This is the highest-leverage fix.

---

### ✅ P0 — Rescue re-arm cooldown

| File | Change |
|------|--------|
| `src/background/prefetch/lanes/rescue-lane.js` | `armRescueLane()` — 2s cooldown (`RESCUE_ARM_COOLDOWN_MS` default). Within cooldown: suppress speculative + cancel pending retries, **skip** generation bump + abort broadcast |
| Same | `RESCUE_GENERATION_BUMP_MIN_MS` (800ms) throttles destructive bumps; uses `broadcastAbortWithoutGenerationBump` when throttled |

**Status:** Shipped (Pass 2). Supplemented in Pass 3 by scoped abort keep-window — see Pass 3 section below.

---

### ✅ P1 — Belt / lookup timeout increases

| Path | Before | After (`xhr.js`) |
|------|--------|------------------|
| Primary non-inflight lookup | 300ms | **600ms** |
| Belt `lookup-miss` | 120ms | **350ms** |
| Belt `not-candidate` | 250ms | **450ms** |

**Status:** Shipped. Gives base64 decode + IPC more room for ~2.2 MB average chunks.

---

### ✅ P1 — Split delivery metrics

| File | Change |
|------|--------|
| `src/page/interceptors/xhr.js` | Emits `cache_lookup_page_delivered` with `viaBase64` flag |
| `src/background/telemetry/collectors/runtime-metrics.js` | Tracks `pageDeliveredHits`; health line shows `bgHitRate` + `pageHitRate` |

**Status:** Shipped. Makes the phantom-hit gap visible in ops.

---

### ✅ Pre-existing hardening (not new in this pass, but relevant)

| Area | Files | What it does |
|------|-------|--------------|
| IDB belt before native | `xhr.js`, `test/page/interceptors/xhr-idb-belt.test.js` | Bounded IDB lookup when registry says `not-candidate` |
| Registry additive sync | `cache-registry.js` (page + BG), tests | Routine syncs add keys only; prevents silent registry wipe |
| Inflight consumer lock | `inflight-consumers.js` | `Preserving in-flight prefetch … player consumer(s) attached` |
| Variant-switch grace | `orchestrator.js`, `video-monitor.js`, `anchor-authority.js` | Retains anchor across signed-URL refresh; suppresses early teleports |
| Write dedup + eviction journal | `db.js`, `eviction-journal.js` | CRC dedup; `evictMiss` telemetry (see [cache-efficiency doc](./cache-efficiency-swiftstream-investigation.md)) |
| Belt miss classification | `runtime-metrics.js`, rollup | XHR belt misses classified against eviction journal |

---

## Open issues (by criticality)

### P1 — Still open

#### 1. Cache byte pressure / eviction churn (long sessions)

**Baseline:** 30+ `HARD_THRESHOLD_BREACH`, 13+ hard eviction passes at 99–102% bytes.

Byte budget vs ~2.2 MB avg chunk ≈ 35–40 useful slots; operating at 800 entries / 100% bytes guarantees churn under extended scrub. Pass 3 log only reached ~13 chunks — not urgent yet, but this caps sustained hit rate on long sessions.

**Fix direction:** P7 eviction scoring (LRU + playback distance); pressure-session `evictMiss` rollup before tuning byte budget. See [cache-efficiency doc](./cache-efficiency-swiftstream-investigation.md).

---

#### 2. Post-fix validation log missing

All ratings below **8/10** are code-confidence ratings. A fresh scrub capture is required to confirm projected 50–70% effective page hit rate and lock in a production score.

---

### P2 — Monitor / residual risk

| Issue | Baseline signal | Status after Pass 3 |
|-------|-----------------|---------------------|
| Playlist URL rotation mid-session | Double rotation @ 18:06:23 | Mitigated (variant grace, non-destructive rescue) |
| `not-candidate` registry lag | `present=false` before `local-add` | **Mitigated** — trust decay + false-negative suspension; belt still backs up |
| Duplicate network fetch same CRC | `crc=90CD5951` prefetched twice | Partially mitigated — demand-start collapse reduces races; dedup still skips IDB write only |
| Writeback suppression | `writebackSuppressed=27` | By design for cached/collapsed XHR sources |
| Buffer health 0% during scrub | Frequent `health=0%` | May be measurement lag during seek trains |
| Inflight cap 8 vs observed 14 | `Prefetch paused: inflight=14` | Monitor; multi-lane accounting may still bypass cap |
| Large chunk belt timeout | Lookup @ 19:01:14, belt @ 19:01:15, prefetch @ 19:01:16 | **Mitigated** — demand-start + wire-first join; byte-aware scheduling prioritizes small chunks |
| DOM anchor reports index 0 during scrub | Anchor=0, predictor=8 | **Mitigated** — reconciliation promotes consensus after 500ms dwell; DOM may still lag briefly |

### ✅ Fixed (were open in Pass 2)

| Issue | Fix | Pass |
|-------|-----|------|
| Phantom page delivery (IPC ArrayBuffer neutered) | Base64 parity on CACHE_LOOKUP | 2 |
| Anchor / playhead divergence during scrub | Weighted-median reconciliation + player-observed signal | 3 |
| Rescue aborts kill useful inflight fetches | Scoped keep-window + relay `keepUrls` bugfix | 3 |
| Queued prefetch invisible to player XHR | `demandStartQueuedPrefetch` + wire-first collapse | 3 |
| Registry binary absent kills lookup | Trust decay + `noteRegistryFalseNegative` | 3 |
| Slow IDB variant chain on warm lookup | In-memory key → primary index | 3 |

### P3 — Ruled out / low priority

| Item | Notes |
|------|-------|
| Mapper ambiguity | `coverage=100%` all session — H2 falsified |
| Seek prediction tuning | Needs more post-fix samples |
| `SW starts=#131` | Lifetime counter |

---

## Hit rate model

### Baseline (pre-fix) — effective ~0–15%

```
Player XHR ──► Page CACHE-LOOKUP ──► ~0% delivered (IPC failure)
                      │
                      ▼
              BG handleCacheLookup ──► 57% IDB hits (misleading metric)
                      │ miss
                      ▼
              network-native + xhr-sync re-store (~16×)
```

### Pass 2 — delivery path repaired

```
Player XHR ──► Page CACHE-LOOKUP ──► bytes via ArrayBuffer OR bytesBase64
                      │ miss
                      ▼
              IDB belt (350–450ms) ──► second chance
                      │ miss
                      ▼
              network-native (legitimate cold path)
```

**Target:** `pageHitRate` within ~10 points of `bgHitRate` (~57%).

### Pass 3 (current) — coordination layer

```
Player XHR ──► wire-first join (demand-start if queued)
                      │ no wire
                      ▼
              CACHE-LOOKUP (registry confidence ≥ 0.3 OR short belt)
                      │ miss
                      ▼
              collapse onto inflight prefetch future
                      │ miss
                      ▼
              network-native (cold path only)

Parallel BG lane:
  anchor reconciliation ──► prefetch window chases consensus playhead
  byte-aware scheduler ──► small chunks complete first → visible hits sooner
  scoped rescue abort ──► keep playhead ±N inflight; kill only far segments
```

**Projected effective page hit rate on aggressive scrub: 50–70%** (up from ~19% in baseline coordination failures). Ceiling still bounded by cache byte pressure on long sessions.

---

## System rating

Ratings are **code-confidence** scores until a post-Pass-3 validation log is captured. See verification protocol below.

### Baseline session (pre-fix log): **4 / 10**

| Dimension | Score | Why |
|-----------|-------|-----|
| Architecture & observability | 8/10 | Excellent telemetry; metrics lied about delivery |
| BG cache storage & lookup | 7/10 | IDB worked; BG hit rate real |
| Page delivery (IPC) | **1/10** | Phantom hits — bytes never reached player |
| Prefetch under churn | 3/10 | Rescue nuked useful work; wrong segments prefetched |
| Scrub / seek handling | 3/10 | Anchor stuck at 0 while player at 8 |
| **Overall** | **4/10** | Storage good; delivery and coordination broken |

### Pass 2 codebase: **7 / 10**

| Dimension | Score | Why |
|-----------|-------|-----|
| Architecture & observability | 8/10 | `bgHitRate` / `pageHitRate` split exposed the gap |
| BG cache storage & lookup | 7/10 | Solid; unchanged |
| Page delivery (IPC) | **7/10** | Base64 parity fixed root cause |
| Prefetch under churn | **5/10** | Cooldown helped re-arms; abort + drift remained |
| Scrub / seek handling | **4/10** | Anchor reconciliation not yet shipped |
| **Overall** | **7/10** | IPC fixed; coordination failures still dominant |

### Pass 3 codebase (current): **8 / 10** — pending validation log

| Dimension | Pass 2 | Pass 3 | Δ | Notes |
|-----------|--------|--------|---|-------|
| Architecture & observability | 8 | **9** | +1 | Reconciliation logs, demand-start metrics, registry false-negative telemetry, 63 tests |
| BG cache storage & lookup | 7 | **8** | +1 | Memory key index; warm lookup is one IDB get |
| Page delivery (IPC + collapse) | 7 | **8** | +1 | Wire-first XHR, demand-start, trust decay; belt may still lose on 8MB+ chunks |
| Prefetch under churn | 5 | **7** | +2 | Scoped rescue + byte-aware scheduling + consumer lock |
| Scrub / seek handling | 4 | **7** | +3 | Weighted-median reconciliation; player-observed signal strongest weight |
| **Overall** | **7** | **8** | **+1** | Coordination layer complete; cache pressure is main remaining drag |

**Rating gates (validation log required to move score):**

| Outcome | Rating adjustment |
|---------|-------------------|
| `pageHitRate` ≥ 45% on aggressive scrub, rescue aborts &lt; 3/min | Confirm **8/10** |
| `pageHitRate` ≥ 55%, `network-native` re-store of known CRCs near zero | Upgrade to **9/10** |
| `pageHitRate` still &lt; 30% with `bgHitRate` &gt; 50% | Downgrade to **6/10** — coordination fixes didn't land in practice |
| Sustained session hits eviction churn (`evictMiss` &gt; 20% of lookups) | Cap at **8/10** until P7 eviction scoring ships |

---

## Verification protocol

1. Reload extension on current Pass 3 build.
2. Reproduce scrub on `swiftstream.top` (~20s aggressive).
3. Capture fresh `logs/log.txt`.
4. Grep:

```bash
rg 'pageHitRate|bgHitRate|CACHE-LOOKUP\] response ok=true hit=true|cache-bytes-unavailable|cache_lookup_page_delivered|WRITEBACK-COMMITTED.*network-native|Rescue lane activated|Delegated prefetch abort|Anchor reconciliation on tab|prefetch_demand_promotion|registry_false_negative|60s metrics rollup' logs/log.txt
```

### Success criteria (Pass 3)

| Check | Target | Confirms |
|-------|--------|----------|
| `ok=true hit=true` | &gt; 0; trending toward BG hit count | IPC delivery (Pass 2) |
| `pageHitRate` on scrub | **≥ 45%** (stretch: ≥ 55%) | Coordination layer (Pass 3) |
| `pageHitRate` vs `bgHitRate` | Within ~15 points (was ~57 pts gap in baseline) | End-to-end pipeline |
| `Anchor reconciliation on tab` | Present during scrub trains | P1 anchor fix active |
| `prefetch_demand_promotion` | &gt; 0 when player races queued prefetch | P3 collapse active |
| `registry_false_negative` | Rare; proves decay works if seen | P4 registry fix active |
| `network-native` for known CRCs | Near zero | No phantom re-downloads |
| Rescue aborts | &lt; 3/min; inflight near playhead preserved | P2 scoped abort |
| `evictMiss` + `cacheEvicted` | Track on long sessions only | P7 readiness signal |

---

## Key source files

| Area | Path |
|------|------|
| BG cache lookup + base64 response | `src/background/messaging/message-router.js` |
| Relay lookup IPC + base64 fallback + `keepUrls` | `src/content/relay.js` |
| Page lookup / belt / wire-first collapse | `src/page/interceptors/xhr.js` |
| Fetch collapse + demand-start | `src/page/interceptors/fetch.js` |
| Demand-start prefetch promotion | `src/page/prefetch/video.js` |
| Lookup bytes resolution | `src/page/bridge/core.js` |
| Registry trust decay | `src/page/cache/cache-registry.js` |
| Anchor reconciliation | `src/background/prefetch/anchor/anchor-reconciler.js` |
| Orchestrator (reconcile + byte-aware schedule) | `src/background/prefetch/arbitration/orchestrator.js` |
| Rescue lane + scoped keep-window | `src/background/prefetch/lanes/rescue-lane.js` |
| Byte-aware scheduling | `src/background/prefetch/policy/prefetch-lane-policy.js` |
| Memory key index | `src/background/cache/db.js` |
| Prefetch abort broadcast | `src/background/prefetch/state/network-generation.js` |
| Inflight consumer protection | `src/background/prefetch/state/inflight-consumers.js` |
| Health metrics | `src/background/telemetry/collectors/runtime-metrics.js` |
| Anchor authority / teleport | `src/background/prefetch/anchor/anchor-authority.js` |
| Related investigation | [cache-efficiency-swiftstream-investigation.md](./cache-efficiency-swiftstream-investigation.md) |

---

## Recommended next work (priority order)

1. **Capture Pass 3 validation log** — only remaining gate before confirming **8/10** (or **9/10**).
2. **Pressure-session `evictMiss` rollup** — quantify cache churn on long sessions; informs P7.
3. **P7 eviction scoring** — LRU + playback distance when sustained sessions exceed ~40 cached chunks.
4. **Seek-prediction tuning** — once post-fix samples exist (was too early at 3 samples).

---

## Pass 3 — timing & coordination batch (2026-06-13)

Log analysis showed most remaining misses were **not true cache misses** — they were coordination failures between predictor, prefetch, lookup, and rescue. Six fixes shipped:

### P1 — Anchor reconciliation (weighted-median consensus)

**Problem:** anchor stuck at 0 while predictor wanted 4→8 and the player actually consumed 8; prefetch burned bandwidth around index 0 for seconds.

| File | Change |
|------|--------|
| `src/background/prefetch/anchor/anchor-reconciler.js` | **New.** Weighted-median consensus from anchor (w2), predictor (w3), player-observed segment (w4), velocity prewarm (w2); signals expire after `ANCHOR_SIGNAL_FRESH_MS` (3s) |
| `src/background/prefetch/arbitration/orchestrator.js` | `maybeReconcileAnchor()` wired into the passenger phase of `handleUnifiedSeekState`, the scrub-suppressed branch of `handleSeekPrediction`, and the hysteresis-deferred branch of `handleChunkObserved`; `handleChunkObserved` now records `lastPlayerObservedIndex` as the strongest playhead evidence |
| `src/background/config/constants.js` | `ANCHOR_RECONCILE_DIVERGENCE_SEGMENTS=3`, `ANCHOR_RECONCILE_DWELL_MS=500`, `ANCHOR_RECONCILE_MIN_INTERVAL_MS=800` |

Rule: consensus diverging from the committed anchor by >3 segments for >500ms promotes via SEEK_PREDICTION authority (log line `Anchor reconciliation on tab …`). Test: `test/background/prefetch/anchor/anchor-reconciler.test.js`.

### P3 — Future-based request collapsing (demand-start)

**Problem:** XHR lookup gave up (belt timeout) ~1s before the prefetch for the same segment completed; queued-but-not-started prefetches were invisible to interceptors.

| File | Change |
|------|--------|
| `src/page/prefetch/video.js` | **`demandStartQueuedPrefetch()`** — player request for a queued segment starts it immediately (bypassing worker concurrency) so the consumer joins the coalesced wire; emits `prefetch_demand_promotion` |
| `src/page/interceptors/xhr.js` | Future-first lane: active/demand-startable wire is joined directly (zero initial IPC); collapse path demand-starts before checking wires |
| `src/page/interceptors/fetch.js` | `shouldAttemptRequestCollapse` demand-starts queued prefetches |

One segment, one future, many consumers. Test: `test/page/prefetch/demand-start-collapse.test.js`.

### P2 — Scoped rescue abort

**Problem:** rescue aborted ALL inflight fetches ("stopped 5 queued/in-flight"), including segments right at the playhead.

| File | Change |
|------|--------|
| `src/content/relay.js` | **Bug fix:** relay was dropping `keepUrls` when forwarding `CancelPrefetch` to the page — the keep window never worked at all |
| `src/background/prefetch/lanes/rescue-lane.js` | Keep window now `playhead − RESCUE_KEEP_BEHIND_SEGMENTS … playhead + RESCUE_KEEP_AHEAD_SEGMENTS` (2/8), centered on the **reconciled consensus** playhead, not the possibly-stale anchor; rescue targets use the same consensus |

Test: `test/background/prefetch/lanes/rescue-scoped-abort.test.js`.

### P4 — Registry trust decay

**Problem:** binary present/absent registry; stale "absent" verdicts killed lookups for bytes that were actually in IDB.

| File | Change |
|------|--------|
| `src/page/cache/cache-registry.js` | `resolveCacheConfidence()`: 0.9 cached / 0.8 inflight / 0.5 never-synced, stale (>10s), or recently caught lying / 0.2 fresh-sync-says-absent. Candidate threshold 0.3. `noteRegistryFalseNegative()` suspends trust for 30s |
| `src/page/interceptors/xhr.js` | Belt hit on a `not-candidate` lane reports a false negative |
| `src/page/interceptors/fetch.js` | Non-candidates no longer skip lookup entirely — they get a short (600ms) lookup; a hit reports a false negative |

Test: `test/page/cache/registry-trust-decay.test.js`.

### P5 — Byte-aware scheduling

| File | Change |
|------|--------|
| `src/background/prefetch/policy/prefetch-lane-policy.js` | `reorderTargetsByByteCost()`: first `BYTE_AWARE_HEAD_SEGMENTS` (3) keep playback order; tail sorted cheapest-first using segment duration as the byte proxy. Uniform playlists untouched |
| `src/background/prefetch/arbitration/orchestrator.js` | Applied before the teleport priority-lane reorder (which still wins) |

Test: `test/background/prefetch/policy/byte-aware-scheduling.test.js`.

### P6 — Two-level in-memory cache index

| File | Change |
|------|--------|
| `src/background/cache/db.js` | In-memory `variant/alias key -> primary chunk key` map (capped 6000). Warm `resolveCachedChunk` is one direct IDB get instead of a per-variant chunk+alias chain walk. Populated on store/dedup/slow-path hits; invalidated on eviction and clear |

### P7 — Eviction scoring

Deferred (log peaks at ~13 chunks stored). Existing LRU + guard-ring protection remains.

---

## Changelog

| Date | Pass | Notes |
|------|------|-------|
| 2026-06-12 | 1 | Initial investigation; baseline log; rating 4/10; phantom-hit root cause identified |
| 2026-06-12 | 2 | Reconcile with shipped fixes (base64 IPC, rescue cooldown, belt timeouts, pageDelivered metrics); correct exit-hysteresis claim; rating 7/10 pending validation; open issues re-ranked |
| 2026-06-12 | 2.5 | Executed fixes for scoped rescue abort, anchor reconciliation during variant-switch, and rescue exit constants |
| 2026-06-13 | 3 | Timing & coordination batch: anchor reconciliation (weighted-median consensus), future-based request collapsing (demand-start), scoped rescue abort (incl. relay `keepUrls` drop bug), registry trust decay, byte-aware scheduling, in-memory cache key index; 5 new test files, 63/63 passing |
| 2026-06-13 | 3.1 | Ratings pass: overall **8/10** (from 7); dimension scores updated; open issues re-ranked; projected scrub hit rate 50–70%; validation gates defined |
