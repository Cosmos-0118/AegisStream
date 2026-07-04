# AegisStream Cache System: Findings & Fixes Summary

## Date: 2026-07-04

---

## ARE WE DOING THE RIGHT THING?

**Yes.** The system correctly prioritizes buffer health over hit rate. The architecture is sound:

```
1. Buffer drops → rescue lane activates → ignores hit rate, fetches NOW
2. Buffer stable → aggressive prefetch ahead of playhead
3. Buffer full → speculative quality-rung exploration (only if hit rate justifies it)
```

**But the cache LOOKUP is too slow.** Valid cached chunks miss because IPC+IDB round-trips exceed the aggressive timeouts. The player falls through to the network and re-downloads 2-5MB from CDN, even when the data is sitting in IndexedDB.

---

## 9 BUGS & GAPS FOUND

| # | Severity | Issue | File:Line |
|---|----------|-------|-----------|
| 1 | CRITICAL | Fetch cache lookup timeout is 600ms for non-candidates; IDB takes 400-800ms under load | `fetch.js:74` |
| 2 | CRITICAL | XHR belt lookup timeout is 250ms; almost always times out against cross-process IDB | `xhr.js:401` |
| 3 | BUG | `BATCH_BACKFILL_MAX_INFLIGHT` undefined; silently falls to 6 instead of 8 (25% throughput loss) | `prefetch-scheduler.js:169` |
| 4 | HIGH | Registry cap at 800 trims oldest (FIFO, not LRU) valid entries; causes false negatives | `cache-registry.js:96` |
| 5 | MEDIUM | Registry freshness is only 10s; after that all absent verdicts drop below confidence threshold | `cache-registry.js:18` |
| 6 | MEDIUM | No age-based eviction; entries from old sessions accumulate until count pressure | `db.js` |
| 7 | HIGH | Fire-and-forget store voids (4 sites); player-consumed chunks silently lost on failure | `xhr.js:218,600`, `fetch.js:53`, `hls-media.js:73` |
| 8 | MEDIUM | Storage passthrough valve permanently disables cache on transient QuotaExceededError | `db.js:48-82` |
| 9 | LOW | Orphaned aliases never reconciled; accumulate from fire-and-forget cleanup | `db.js:452` |

---

## WHY 400+ CACHE ENTRIES?

400 is **normal** — it's 80% of the 500-entry default budget. Lane 3 (45s reconcile) fires at 70% but only targets 60% (300 entries). Soft eviction doesn't trigger until 90% (450).

The real issues:
- No TTL cleanup — stale entries accumulate between sessions
- Scrub suppression chains — soft eviction deferred indefinitely during scrubbing
- Guard ring protects 15-30 entries per tab unconditionally, no time decay
- Aliases not counted in budget — actual footprint larger than reported

---

## FIX PRIORITY

### Tier 1 — Fix the hit rate (highest impact, lowest risk)

1. **Increase cache lookup timeouts**:
   - `fetch.js:74`: Change `600` → `1200` for non-candidates
   - `xhr.js:401`: Change `250` → `800` for XHR belt
2. **Fix BATCH_BACKFILL_MAX_INFLIGHT**: Change to `PREFETCH_BATCH_INFLIGHT_CAP` (8)
3. **Increase REGISTRY_FRESH_MS**: `10_000` → `30_000`
4. **Double registry cap**: `800` → `1600`, or switch to LRU eviction

### Tier 2 — Clean up the cache

5. **Add TTL eviction**: Sweep entries older than 60 minutes
6. **Add alias reconciliation**: Clean orphaned aliases in Lane 3
7. **Count aliases in budget**: Include STORE_ALIASES in eviction summary

### Tier 3 — Improve reliability

8. **Await fire-and-forget stores**: Add re-fetch scheduling on persistent failure
9. **Add temporary passthrough cooldown**: Retry after 60s instead of permanent disable
10. **Reduce guard ring size** or **add time decay** during seek churn
11. **Reduce relay base64 chunk size**: 32k → 8k for call-stack safety

### Tier 4 — Prefetch accuracy

12. Reduce reconciler dwell from 500ms → 250ms during scrub
13. Add small backward prefetch ring on backward seeks
14. Trigger rescue from page-side buffer drop without IPC round-trip wait
