(() => {
var ns = (self.AegisBackground ||= {})
const { constants, state, addLog } = ns

/**
 * Pattern-addressed segment ladders.
 *
 * Some players never expose an interceptable `.m3u8`/`.mpd`. They address
 * segments purely by a sequential counter baked into the URL, often under a
 * decoy extension (`.../1080p/0007.jpg`). Such URLs match neither
 * `isPlaylistUrl` nor `isLikelyChunkUrl`, so the tab never receives a
 * `segments` array — and every prefetch entry point short-circuits on its
 * empty-array guard. The engine then stays dormant for the whole session
 * while the cache degenerates into write-behind for a workload that never
 * re-requests a segment, i.e. no possible hit.
 *
 * This module recovers the timeline from segments the page has *already*
 * fetched: once several same-shaped, media-sized, near-consecutive URLs have
 * been observed on one tab, the counter is extrapolated into a synthetic
 * segment list and handed to the normal playlist pipeline. Anchoring,
 * windowing, lanes and eviction downstream then work unmodified.
 *
 * Adoption is deliberately conservative — it fires only for a tab with no
 * real playlist, and only on payloads far too large to be page furniture —
 * because a false positive would aim the prefetcher at an image gallery.
 */

const DEFAULTS = {
  minBytes: 256 * 1024,
  minObservations: 3,
  maxIndexGap: 3,
  observationTtlMs: 3 * 60 * 1000,
  synthCount: 2000,
  minDigits: 2
}

function tunable(name, fallback) {
  const value = Number(constants?.[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Lazy leading group so the digit run is captured whole and the *last* run in
 * the basename wins: `chunk12_003.ts` -> prefix `chunk12_`, digits `003`.
 * A greedy leading group would instead split the final run ("00" + "3").
 */
const SEGMENT_BASENAME_RE = /^(.*?)(\d{2,})(\.[A-Za-z0-9]{1,5})?$/

function parseSequentialSegmentUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return null
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  const pathname = parsed.pathname || ""
  const slash = pathname.lastIndexOf("/")
  if (slash < 0) return null
  const basename = pathname.slice(slash + 1)
  if (!basename) return null

  const match = SEGMENT_BASENAME_RE.exec(basename)
  if (!match) return null
  const prefix = match[1]
  const digits = match[2]
  const suffix = match[3] || ""
  if (digits.length < tunable("SEQUENTIAL_SEGMENT_MIN_DIGITS", DEFAULTS.minDigits)) return null

  const index = Number(digits)
  if (!Number.isSafeInteger(index) || index < 0) return null

  const dir = `${parsed.origin}${pathname.slice(0, slash + 1)}`
  // The query is carried verbatim into synthesized URLs, so a ladder is only
  // coherent while it stays byte-identical. A per-segment token would produce
  // a different patternKey each time and never reach the observation floor —
  // which is the intended outcome, since we could not forge those tokens.
  const search = parsed.search || ""

  return {
    dir,
    prefix,
    width: digits.length,
    suffix,
    search,
    index,
    patternKey: `${dir}|${prefix}|${digits.length}|${suffix}|${search}`
  }
}

function buildSequentialSegmentUrls(pattern, count) {
  if (!pattern || !Number.isFinite(count) || count <= 0) return []
  const urls = new Array(count)
  for (let i = 0; i < count; i += 1) {
    const counter = String(i).padStart(pattern.width, "0")
    urls[i] = `${pattern.dir}${pattern.prefix}${counter}${pattern.suffix}${pattern.search}`
  }
  return urls
}

// tabId -> { patternKey, pattern, seen: Map<index, observedAt>, adopted }
const trackers = new Map()

function pruneObservations(tracker, now) {
  const ttl = tunable("SEQUENTIAL_SEGMENT_OBSERVATION_TTL_MS", DEFAULTS.observationTtlMs)
  for (const [index, seenAt] of tracker.seen) {
    if (now - seenAt > ttl) tracker.seen.delete(index)
  }
}

/**
 * Requires a forward-moving run rather than a bare count, so that N unrelated
 * same-shaped URLs (a sprite sheet, a paginated gallery) cannot qualify.
 */
function hasConsecutiveRun(tracker) {
  const minObservations = Math.max(
    2,
    Math.round(tunable("SEQUENTIAL_SEGMENT_MIN_OBSERVATIONS", DEFAULTS.minObservations))
  )
  const maxGap = tunable("SEQUENTIAL_SEGMENT_MAX_INDEX_GAP", DEFAULTS.maxIndexGap)
  const indices = [...tracker.seen.keys()].sort((a, b) => a - b)
  if (indices.length < minObservations) return false

  let run = 1
  for (let i = 1; i < indices.length; i += 1) {
    const gap = indices[i] - indices[i - 1]
    run = gap > 0 && gap <= maxGap ? run + 1 : 1
    if (run >= minObservations) return true
  }
  return false
}

function adoptSequentialLadder(tabId, tracker, pattern) {
  if (typeof ns.upsertPlaylistState !== "function") return false
  const count = Math.max(
    1,
    Math.round(tunable("SEQUENTIAL_SEGMENT_SYNTH_COUNT", DEFAULTS.synthCount))
  )
  const segments = buildSequentialSegmentUrls(pattern, count)
  if (!segments.length) return false

  const pageUrl =
    typeof ns.getTabPageUrlFingerprint === "function" ? ns.getTabPageUrlFingerprint(tabId) : null
  const tabState = ns.upsertPlaylistState(tabId, segments, { pageUrl, syntheticSequence: true })
  if (!tabState) return false

  tracker.adopted = true
  tracker.adoptedAt = Date.now()
  tabState.syntheticSequence = true
  tabState.syntheticSequencePattern = pattern.patternKey

  // A tab can be parked in auth_expired purely because manifest refresh kept
  // retrying a playlist this site does not serve. A working ladder proves
  // there is nothing to refresh, and isPrefetchBlocked() treats auth_expired
  // as a hard stop — so without clearing it the ladder would be inert.
  if (
    tabState.refreshState === ns.REFRESH_STATE_AUTH_EXPIRED &&
    typeof ns.transitionRefreshState === "function"
  ) {
    ns.transitionRefreshState(tabId, tabState, ns.REFRESH_STATE_HEALTHY, "sequential-ladder-adopted")
  }

  addLog(
    "INFO",
    `Adopted sequential segment ladder on tab ${tabId} (pattern=${pattern.prefix}<${pattern.width}d>${pattern.suffix || ""}, observed=${tracker.seen.size}, synthesized=${segments.length})`
  )
  if (typeof ns.bumpActivity === "function") ns.bumpActivity("sequentialLaddersAdopted", 1)
  return true
}

/**
 * Called for every chunk the page successfully stores, where both the URL and
 * its byte length are known. Returns true only on the observation that adopts
 * a ladder, so the caller can drive first anchoring.
 */
ns.noteSequentialSegmentObservation = function noteSequentialSegmentObservation(
  tabId,
  url,
  byteLength
) {
  if (!Number.isFinite(tabId)) return false
  if (!state?.settings?.enabled || state.settings.prefetchEnabled === false) return false
  if (!(Number(byteLength) >= tunable("SEQUENTIAL_SEGMENT_MIN_BYTES", DEFAULTS.minBytes))) {
    return false
  }

  const tabState = state.playlistByTab.get(tabId)
  // Never shadow a genuinely parsed playlist.
  if (tabState?.segments?.length && tabState.syntheticSequence !== true) return false

  const pattern = parseSequentialSegmentUrl(url)
  if (!pattern) return false

  if (typeof ns.isNonAcceleratableEmbedHost === "function") {
    try {
      if (ns.isNonAcceleratableEmbedHost(new URL(url).hostname)) return false
    } catch {
      return false
    }
  }

  const now = Date.now()
  let tracker = trackers.get(tabId)
  if (!tracker || tracker.patternKey !== pattern.patternKey) {
    tracker = { patternKey: pattern.patternKey, pattern, seen: new Map(), adopted: false }
    trackers.set(tabId, tracker)
  }
  tracker.pattern = pattern
  tracker.seen.set(pattern.index, now)
  pruneObservations(tracker, now)

  if (tracker.adopted) return false
  if (!hasConsecutiveRun(tracker)) return false
  return adoptSequentialLadder(tabId, tracker, pattern)
}

ns.resetSequentialSegmentTracking = function resetSequentialSegmentTracking(tabId) {
  if (!Number.isFinite(tabId)) {
    trackers.clear()
    return
  }
  trackers.delete(tabId)
}

ns.getSequentialSegmentTracker = function getSequentialSegmentTracker(tabId) {
  return trackers.get(tabId) || null
}

ns.parseSequentialSegmentUrl = parseSequentialSegmentUrl
ns.buildSequentialSegmentUrls = buildSequentialSegmentUrls
})()
