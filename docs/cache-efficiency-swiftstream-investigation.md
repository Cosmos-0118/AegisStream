# Cache efficiency investigation — swiftstream / obfuscated HLS hosts

This document captures the cache-efficiency investigation on obfuscated streaming hosts (primarily **swiftstream.top** / animetsu-style players) as of **2026-06-07**. It is written for developers who need context on what was measured, what was ruled out, what telemetry exists, and what remains before changing eviction, retention, or prefetch behavior.

---

## Problem statement

On swiftstream-style hosts, playback can feel cache-inefficient: repeated network fetches, belt lookup misses, and high write volume under scrubbing. Before tuning cache policy, we needed **evidence** on whether misses are caused by:

| Hypothesis | Description |
|------------|-------------|
| **H1** | Retention / eviction — chunks evicted under byte pressure, then missed on replay |
| **H2** | Manifest mapper ambiguity — multiple segment URLs collapse to the same signature |
| **H3** | Lookup path failure — playlist index is fine but chunk URL → cache key resolution fails |
| **H4** | Duplicate writes — same `(invariantKey, crc)` stored multiple times |
| **H5** | Page-side belt races — `[CACHE-LOOKUP-BELT]` misses before background write completes |

The engineering rule agreed during this investigation:

> **Do not modify eviction policy, cache sizing, or prefetch until `evictMiss` (`recentlyEvictedMissRatePercent`) is measured under real byte pressure.**

---

## Key distinction: pressure vs damage

| Term | Meaning | Status on swiftstream (sessions to date) |
|------|---------|------------------------------------------|
| **Retention pressure** | Cache bytes near limit; hard evictions fire | Proven in earlier short sessions (`HARD_THRESHOLD_BREACH`, adaptive eviction) |
| **Retention damage** | Evicted chunks are later requested and miss | **Unknown** — `evictMiss=0` in all rollup windows because `cacheEvicted=0` in the captured 60s window |

Low `evictMiss` with **zero evictions** is expected, not proof that retention is healthy.

---

## Hypothesis results

### H2 — Manifest mapper ambiguity: **FALSIFIED**

Across all analyzed swiftstream sessions:

- `Playlist Index Quality` logs consistently show `coverage=100%`, `duplicateRate=0%`, `ambiguousMappings=0%`
- Example log line:

```
Playlist Index Quality tab=414363926 host=swiftstream.top segments=325 uniqueSignatures=325 duplicateSignatures=0 duplicateRate=0% ambiguousMappings=0 coverage=100% examples=none
```

Signature logic lives in `src/background/media/manifest-mapper.js` (`getManifestUrlSignature`, `buildManifestSequenceIndex`, `analyzeManifestIndexQuality`).

**Conclusion:** Do not spend effort on mapper signature changes for swiftstream until a different host shows ambiguous mappings.

### H4 — Duplicate ingestion: **ADDRESSED AND HIGH-IMPACT**

Write dedup before IndexedDB insert skips repeats of `(invariantKey|crc|byteLength)` within a TTL window (default 5 minutes via `CACHE_STORE_INVARIANT_CRC_DEDUP_MS`).

Observed in logs:

- `StoreChunk accepted` logs **before** dedup runs
- Suppressed writes have **no** following `Cached chunk from page` line
- First 60s rollup with split counters: `cacheDedup=39(crc=39,url=0)` — all dedup via invariant+crc path, none via URL-window dedup

**This line is bigger than it looks.** We finally have proof that `(invariantKey, crc)` dedup is doing real work — not same-URL observation, not URL-window suppression, but **duplicate content ingestion**. 39 suppressions in 60 seconds is substantial.

**Priority elevation:** duplicate-ingestion suppression is now ranked **above** lookup-path optimization for swiftstream. Dedup is not a minor optimization; it is one of the highest-impact changes measured so far.

### H5 — Belt lookup races: **EXPECTED BEHAVIOR + NOW CLASSIFIED**

Pattern in logs:

1. `StoreChunk accepted`
2. `[CACHE-LOOKUP-BELT] request` (often `lane=not-candidate`)
3. `[CACHE-LOOKUP-BELT] miss`
4. `Cached chunk from page` ~50–200ms later

This is a cold-path race (lookup before write lands), not eviction damage. Belt misses should not be interpreted as retention failure.

As of **2026-06-07**, XHR belt misses/timeouts now emit runtime metrics with URL context and are classified through `noteRecentlyEvictedMiss()` (except `lane=lookup-miss`, which is skipped to avoid double-counting misses already classified by background `handleCacheLookup`).

### H1 — Retention damage: **NOT YET MEASURABLE**

`evictMiss` telemetry is implemented but every captured rollup window had `cacheEvicted=0`. Decision deferred until a session with hard evictions + rollup.

### H3 — Lookup mapping coverage: **INSTRUMENTED (NEW)**

Runtime lookup mapping coverage is now tracked at `handleCacheLookup` time:

- `lookupMappingChecks`
- `lookupMappingResolved`
- `lookupMappingUnresolved`
- derived `lookupMappingCoveragePercent` (reported in the 60s rollup as `lookupMap=...`)

This closes the original H3 measurement gap: playlist `coverage=100%` can now be compared against actual chunk lookup mapping coverage during playback.

---

## Telemetry added during this investigation

### 1. Evict-then-miss journal

**File:** `src/background/cache/eviction-journal.js`

At eviction time, records evicted chunks (distance from anchor, `manifestMapped`, `invariantKey`). On background cache lookup miss, `noteRecentlyEvictedMiss()` classifies:

- **Recently evicted** — chunk was in cache but evicted within journal TTL
- **Never stored** — no eviction record found

**Log on hit:**

```
MISS recently_evicted key=... evicted=Ns ago size=... distance=... manifestMapped=...
```

**Counters** (in `state.stats` / activity metrics):

| Counter | Meaning |
|---------|---------|
| `recentlyEvictedMisses` | Lookup miss on a recently evicted chunk |
| `cacheMissNeverStored` | Lookup miss with no eviction record |
| `evictedMissUnmapped` | Evicted miss where chunk had no manifest map at eviction |
| `evictedWithoutManifestMap` | Evictions without manifest distance |
| `cacheChunksEvicted` | Total chunks evicted |

**Hook points:**

- Eviction: `src/background/cache/db.js` → `runEvictionPass()` → `recordEvictedChunks()`
- Lookup miss: `src/background/telemetry/collectors/activity-metrics.js` → `recordCacheLookupMiss()` → `noteRecentlyEvictedMiss()`

**Update (2026-06-07):** XHR page-side belt misses/timeouts now classify through the same eviction journal path via runtime metrics (`runtime-metrics.js`), with a guard to skip `lane=lookup-miss` and avoid duplicate classification when background miss accounting already ran.

### 2. Write dedup (split counters)

**File:** `src/background/cache/db.js` → `cacheChunk()`

Before IDB write, skip if `(invariantKey|crc|byteLength)` seen within dedup TTL.

| Counter | Meaning |
|---------|---------|
| `storeDedupInvariantCrcSkipped` | Skipped via invariant+crc dedup |
| `storeDedupUrlWindowSkipped` | Skipped via URL-window dedup |
| `storeDedupSkipped` | Aggregate of both |

CRC is computed from first 64KB + total byte length on post-decode bytes. Used for write dedup only, not integrity verification.

### 3. Manifest index quality

**File:** `src/background/media/manifest-mapper.js`

`analyzeManifestIndexQuality()` + `recordManifestIndexQuality()` called at playlist upsert in `src/background/prefetch/arbitration/orchestrator.js`.

Logs per upsert:

```
Playlist Index Quality tab=<id> host=<host> segments=N uniqueSignatures=N duplicateSignatures=0 duplicateRate=0% ambiguousMappings=0 coverage=100% examples=none
```

### 4. Lookup mapping coverage (runtime)

**Files:** `src/background/messaging/message-router.js`, `src/background/media/manifest-mapper.js`

On each eligible non-UMP background cache lookup, we now record whether chunk URL → manifest index resolution succeeded at lookup time.

**Counters:**

| Counter | Meaning |
|---------|---------|
| `lookupMappingChecks` | Eligible lookup mapping checks |
| `lookupMappingResolved` | Checks where URL resolved to manifest index |
| `lookupMappingUnresolved` | Checks where URL did not resolve |

**Summary API:** `getLookupMappingCoverageSummary()` now exposes aggregate coverage and per-tab worst/latest coverage snapshots.

### 5. 60-second metrics rollup

**File:** `src/background/telemetry/collectors/metrics-aggregator.js`

Every 60s, emits:

```
AegisStream 60s metrics rollup — scrub=..., spec=..., lookups=N(hits=H,miss=M,hitRate=P%), cacheDedup=N(crc=X,url=Y), lookupMap=C(ok=R,miss=U,coverage=P%), evictMiss=N(P%), beltMiss=M(timeout=T,evict=E/C,rate=Q%), evictMissUnmapped=N, cacheEvicted=N
```

**Decision fields:**

| Field | How to read it |
|-------|----------------|
| `hitRate` | Background lookup effectiveness in the 60s delta |
| `cacheDedup` | Duplicate write suppression volume |
| `lookupMap` | Runtime chunk URL → manifest index resolution coverage |
| `evictMiss` | Misses on chunks evicted within journal TTL |
| `evictMiss` percentage | `recentlyEvictedMisses / (recentlyEvictedMisses + cacheMissNeverStored)` |
| `beltMiss` | XHR belt misses/timeouts plus eviction classification split |
| `cacheEvicted` | Must be **> 0** for `evictMiss` to be meaningful |

**Interpretation guide:**

| Pattern | Likely meaning |
|---------|----------------|
| Low `evictMiss`, high `hitRate`, `cacheEvicted > 0` | Cache is busy but effective under pressure (**Possibility A**) |
| High `evictMiss`, falling `hitRate`, `cacheEvicted > 0` | Retention is hurting replay (**Possibility B**) → then tune retention/budget |
| `evictMiss=0`, `cacheEvicted=0` | Warm cache, no pressure — **inconclusive** for retention |

Companion lines in the same health tick:

- `AegisStream realtime health` — cumulative lifetime stats since SW activation
- `AegisStream pain report` — weighted pain sources (cache misses, speculative denied, stalls, etc.)

---

## Log analysis summary (sessions captured in `logs/log.txt`)

All sessions target tab `414363926` on `swiftstream.top`, ~325 segments.

| Session | Time (UTC) | Duration | HARD_THRESHOLD | Evictions | Hit rate | Index quality | Dedup (approx) | 60s rollup |
|---------|------------|----------|----------------|-----------|----------|---------------|----------------|------------|
| 1 | ~19:02 | ~19s | 50 | 18 | 65% | 17× 100% | 47 accept / 37 write (~21%) | No |
| 2 | ~19:07 | ~11s | 39 | 12 | 65% | 29× 100% | 39 accept / 24 write (~38%) | No |
| 3 | ~19:16 | ~47s | 0 | 0 | 90% | 20× 100% | 75 accept / 51 write (~32%) | No |
| 4 | ~19:18 | ~14s log window | 0 | 0 | 72% rollup / 67% lifetime | 28× 100% | 37 accept / 20 write (~46%) | **Yes** |

### Session 4 — first valid rollup (2026-06-05T19:18:51Z)

```
AegisStream 60s metrics rollup — scrub=6(skip=18), spec=alloc 0 hit 0 miss 0 eff n/a, saved=0ms, stalls=0ms, kalmanResets=0, lookups=64(hits=33,miss=13,hitRate=72%), cacheDedup=39(crc=39,url=0), evictMiss=0(0%), evictMissUnmapped=0, cacheEvicted=0
```

Lifetime at same tick (`realtime health`):

- `lookups=338, hits=225, miss=113, hitRate=67%`
- `writebackSuppressed=200`
- `stores(ok=271, fail=15, avgKB=736.0)`
- Registry keys grew **213 → 232** (warm cache)
- `SW starts=#1` — single service worker lifetime; rollup includes activity before log capture began

**Consistent findings across all sessions:**

- Mapper healthy on swiftstream (H2 dead)
- Background hits work (`Cache HIT`, `Cache HIT via wire`)
- Under pressure (sessions 1–2): continuous high byte usage, hard evictions, ~800KB–1.1MB average chunks
- `evictMiss` / `MISS recently_evicted` = **0 everywhere** (no evictions in rollup window, or rollup absent)
- Belt misses are common but are cold-path races, not retention signals

---

## Analysis after first 60s rollup

The first 60s rollup is extremely valuable because it finally answers several questions at once.

### Biggest takeaway: retention pressure is not the leading hypothesis *for this window*

For the last few sessions we had been seeing:

- `HARD_THRESHOLD_BREACH`
- `Adaptive cache eviction`
- 94–100% occupancy

…and naturally gravitating toward: **retention pressure is the bottleneck**.

But the Session 4 rollup says:

```
cacheEvicted=0
evictMiss=0
```

while simultaneously showing:

```
lookups=64, hits=33, miss=13, hitRate=72%
cacheDedup=39(crc=39,url=0)
```

That means during this window:

- Cache worked
- Dedup worked
- Mapper worked
- No eviction occurred
- Hit rate remained healthy

**This rollup does not support the current leading hypothesis** (retention pressure as primary bottleneck) — at least not in steady-state mode. Pressure and damage remain separate questions.

### Writeback suppression is enormous

Lifetime snapshot from the same tick:

```
stores(ok=271)
writebackSuppressed=200
```

That is nearly `200 / (271 + 200) ≈ 42%` of attempted writes being avoided at the page layer — before background store dedup even runs. This is no longer a minor optimization.

**Future question (deferred):** do suppressed writes correlate with wire collapse, prefetch overlap, or XHR rereads? Not yet investigated.

### Revised concern ranking (swiftstream)

| Concern | Score | Notes |
|---------|-------|-------|
| Mapper ambiguity | **0/10** | Falsified across all sessions |
| Lookup architecture | **2/10** | Low priority; belt races explain most visible misses |
| Eviction damage | **Unknown** | Cannot score until `cacheEvicted > 0` in a rollup |
| Duplicate ingestion | **6/10** | Proven high impact via `cacheDedup` + writeback suppression |
| Retention pressure | **Depends** | Proven under scrub (sessions 1–2); harm unproven |

Intentionally separating **retention pressure** (evictions fire) from **retention damage** (evictions cause useful misses) — this rollup proves they are not the same thing.

---

## Two operating modes

We now think swiftstream exhibits two distinct modes:

### Mode A — steady state (Session 4 rollup)

```
cacheEvicted=0
hitRate=72%
cacheDedup=39
```

System looks healthy. Cache, dedup, and mapper all working. No evidence of retention damage because no evictions occurred in the window.

### Mode B — aggressive scrub pressure (sessions 1–2)

```
39+ HARD_THRESHOLD_BREACH
multiple hard evictions
expanded guard ring
rescue lane active
```

We still do **not** know whether Mode B causes `evictMiss > 0` or merely causes churn without useful misses. That is the single most important unknown remaining.

---

## Interpretation matrix (when `cacheEvicted > 0`)

Use this after a **pressure session** rollup — both fields must appear in the **same** 60s window:

| Rollup reads | Interpretation | Action |
|--------------|----------------|--------|
| `cacheEvicted=50`, `evictMiss=0` | Evictions are noisy, not harmful | **Strongly resist** retention-policy changes |
| `cacheEvicted=50`, `evictMiss=15(30%)` | Evictions removing useful data | Retention becomes the **primary** optimization target |
| `cacheEvicted=0`, `evictMiss=0` | Warm cache / no pressure in window | **Inconclusive** — not evidence retention is fine |

The goal is to capture `cacheEvicted > 0` and `evictMiss = ?` in the same rollup.

---

## Current engineering verdict

| Area | Status | Action |
|------|--------|--------|
| Mapper signatures (H2) | Ruled out for swiftstream | No change |
| Write dedup / duplicate ingestion (H4) | Shipped, high impact (~42% writeback + crc dedup) | Monitor; do not regress |
| Lookup mapping coverage (H3) | Instrumented (`lookupMap`) | Monitor under pressure before architecture changes |
| Lookup path optimization | Low priority | Defer until pressure session completes |
| Evict-then-miss (H1) | Instrumented, inconclusive | Collect session with `cacheEvicted > 0` |
| Eviction algorithm / cache budget | Unknown impact | **Do not change yet** |
| Prefetch / retention tuning | Unknown impact | **Do not change yet** |
| Belt miss → evict classification | Instrumented for XHR belt miss/timeout | Compare against pressure-session `evictMiss` windows |

---

## How to collect the missing data (pressure session — not normal playback)

**Do not run another normal playback session.** The next highest-value experiment is a **forced-pressure session** with a rollup **after** evictions occur.

Steps:

1. **Reload** on the current build (rollup + split dedup counters must be active).
2. **Scrub aggressively** on swiftstream — jump around, expand guard ring, trigger rescue lane.
3. Continue until both are visible in logs:
   - `HARD_THRESHOLD_BREACH`
   - `Adaptive cache eviction`
4. **Keep running** long enough for a full 60s rollup **after** eviction activity begins.
5. Grep the log:

```bash
rg '60s metrics rollup|HARD_THRESHOLD|Adaptive cache eviction|MISS recently_evicted|cacheEvicted' logs/log.txt
```

6. Read the rollup line — `evictMiss`, `cacheEvicted`, and `hitRate` **together** (see interpretation matrix above).

### What we are trying to answer

> When eviction actually happens, does it cause useful misses?

Everything else is finally measured well enough that we can stop guessing.

### Do not modify yet

Until the pressure-session rollup is captured:

- Eviction algorithm
- Cache sizing / budget
- Mapper signatures
- Lookup path architecture

---

## Key source files

| Component | Path |
|-----------|------|
| Eviction journal + dedup map | `src/background/cache/eviction-journal.js` |
| Cache writes, eviction pass, dedup gates | `src/background/cache/db.js` |
| Manifest signatures + index quality | `src/background/media/manifest-mapper.js` |
| Runtime lookup mapping coverage | `src/background/messaging/message-router.js`, `src/background/media/manifest-mapper.js` |
| Index quality at playlist upsert | `src/background/prefetch/arbitration/orchestrator.js` |
| 60s rollup formatting | `src/background/telemetry/collectors/metrics-aggregator.js` |
| Lookup miss → evict journal | `src/background/telemetry/collectors/activity-metrics.js` |
| Belt miss runtime metric classification | `src/background/telemetry/collectors/runtime-metrics.js` |
| Background cache lookup routing | `src/background/messaging/message-router.js` |
| Invariant cache keys | `src/shared/media-cache-key.js` |
| Page belt lookups | `src/page/interceptors/xhr.js`, `src/content/relay.js` |

---

## Tests

| Test file | Covers |
|-----------|--------|
| `test/background/cache/eviction-journal.test.js` | Eviction journal + recently-evicted miss classification |
| `test/background/media/manifest-mapper.test.js` | Index quality + runtime lookup mapping coverage summary |
| `test/background/telemetry/collectors/metrics-aggregator.test.js` | Rollup includes `cacheDedup` / `evictMiss` / `lookupMap` / `beltMiss` deltas |
| `test/background/telemetry/collectors/runtime-metrics-belt.test.js` | XHR belt miss/timeout eviction classification path |

Run:

```bash
npm test -- test/background/cache/eviction-journal.test.js test/background/media/manifest-mapper.test.js test/background/telemetry/collectors/metrics-aggregator.test.js test/background/telemetry/collectors/runtime-metrics-belt.test.js
```

---

## Future work (deferred)

1. **Pressure session rollup** — `cacheEvicted > 0` + `evictMiss = ?` in the same 60s window (blocks all retention decisions).
2. **Writeback suppression correlation** — do the ~42% suppressed writes map to wire collapse, prefetch overlap, or XHR rereads?
3. **Pressure-session `lookupMap` validation** — capture whether runtime lookup mapping coverage degrades under aggressive scrub/rotation.
4. **Fetch-path belt parity** — if needed, extend equivalent belt classification for fetch-side fallback paths (XHR is instrumented now).
5. **Retention / budget tuning** — only after high `evictMiss` under `cacheEvicted > 0` confirms eviction damage (interpretation matrix).

---

## Related prior fixes (same investigation arc)

These shipped alongside telemetry and are orthogonal to the retention question but affect observed hit rates:

- `noteLocalCacheKey` on cache HIT in xhr/fetch interceptors
- Extension context invalidated fix in `src/content/relay.js`
- Quality stability fixes (rung hysteresis, cross-itag gating, FSM masking)

---

## Changelog

| Date | Notes |
|------|-------|
| 2026-06-05 | Initial document: H2 falsified, dedup + evictMiss telemetry shipped, four log sessions analyzed, first 60s rollup captured with `cacheEvicted=0` |
| 2026-06-05 | Post-rollup analysis: retention pressure ≠ retention damage; duplicate ingestion elevated to 6/10; Mode A/B framework; interpretation matrix; pressure session protocol; writeback suppression ~42% noted |
| 2026-06-07 | H3 instrumented: runtime `lookupMap` coverage counters + summary + rollup field. Belt under-counting closed for XHR: belt miss/timeout now classified against eviction journal (with `lookup-miss` dedupe guard) and exposed in rollup via `beltMiss`. |
