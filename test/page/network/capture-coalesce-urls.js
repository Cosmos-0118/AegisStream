/**
 * Paste into DevTools console on an anime embed player page during playback.
 * Collects segment URL shapes for Slice 1 validation (path vs query discriminators).
 *
 * Usage:
 *   1. Start playback on AnimePahe / HiAnime / Aniwatch / Zoro clone
 *   2. Paste this entire file into the page console (MAIN world if possible)
 *   3. Scrub/seek for ~30s, then run: AegisCoalesceCapture.report()
 */
(function installCoalesceCapture() {
  const seen = new Map()
  const SELECTOR_CANDIDATES = [
    "track",
    "quality",
    "stream",
    "variant",
    "bitrate",
    "v",
    "rendition",
    "audio",
    "lang",
    "id"
  ]

  function classify(url) {
    try {
      const u = new URL(url, location.href)
      const selectors = {}
      for (const key of SELECTOR_CANDIDATES) {
        if (u.searchParams.has(key)) selectors[key] = u.searchParams.get(key)
      }
      return {
        host: u.hostname,
        pathname: u.pathname,
        hasQuery: u.search.length > 1,
        selectors,
        ext: (u.pathname.match(/\.([a-z0-9]+)$/i) || [])[1] || null
      }
    } catch {
      return { host: null, pathname: null, hasQuery: false, selectors: {}, ext: null }
    }
  }

  function note(url) {
    if (typeof url !== "string" || !/\.(ts|m4s|mp4|aac|m3u8)($|\?)/i.test(url)) return
    const profile = classify(url)
    const structural = `${profile.host || ""}${profile.pathname || ""}`.toLowerCase()
    const bucket = seen.get(structural) || {
      structural,
      samples: [],
      selectorShapes: new Set(),
      tokenVariants: new Set()
    }
    if (bucket.samples.length < 3) bucket.samples.push(url)
    const token = (url.match(/[?&](token|sig|expires|auth)=([^&]+)/i) || [])[2]
    if (token) bucket.tokenVariants.add(token.slice(0, 12))
    const selectorKeys = Object.keys(profile.selectors)
    if (selectorKeys.length) {
      bucket.selectorShapes.add(
        selectorKeys.map((k) => `${k}=${profile.selectors[k]}`).join("&")
      )
    }
    seen.set(structural, bucket)
  }

  const bridge = globalThis.AegisPageBridge
  if (bridge?.originalFetch) {
    const orig = bridge.originalFetch
    bridge.originalFetch = function patchedFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url
      note(url)
      return orig.apply(this, arguments)
    }
  }

  if (bridge?.OriginalXHR) {
    const Orig = bridge.OriginalXHR
    const open = Orig.prototype.open
    Orig.prototype.open = function (method, url) {
      note(url)
      return open.apply(this, arguments)
    }
  }

  globalThis.AegisCoalesceCapture = {
    note,
    report() {
      const rows = [...seen.values()].map((b) => ({
        structural: b.structural,
        sampleCount: b.samples.length,
        tokenVariantCount: b.tokenVariants.size,
        querySelectors: [...b.selectorShapes],
        sample: b.samples[0]
      }))
      const pathBased = rows.filter((r) => !r.querySelectors.length).length
      const queryBased = rows.filter((r) => r.querySelectors.length).length
      console.table(rows.slice(0, 30))
      console.log(
        `Coalesce capture: ${rows.length} structural keys, path-only=${pathBased}, query-discriminated=${queryBased}`
      )
      return rows
    }
  }

  console.log("AegisCoalesceCapture installed — play video, then AegisCoalesceCapture.report()")
})()
