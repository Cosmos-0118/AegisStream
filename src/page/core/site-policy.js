(() => {
  if (globalThis.AegisSitePolicy) return

  const TWITCH_PAGE_HOST_SUFFIXES = [".twitch.tv"]

  function normalizeHost(hostname) {
    return String(hostname || "").toLowerCase()
  }

  function hostMatchesSuffix(host, suffix) {
    const normalized = normalizeHost(host)
    if (!normalized) return false
    const bare = suffix.startsWith(".") ? suffix.slice(1) : suffix
    return normalized === bare || normalized.endsWith(suffix)
  }

  function isTwitchPageHost(host) {
    const normalized = normalizeHost(host)
    if (!normalized) return false
    if (normalized === "twitch.tv") return true
    return TWITCH_PAGE_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(normalized, suffix))
  }

  function isTwitchMediaUrl(url) {
    if (typeof url !== "string" || !url) return false
    try {
      const parsed = new URL(url, location.href)
      const host = normalizeHost(parsed.hostname)
      if (!isTwitchPageHost(host) && !host.endsWith(".ttvnw.net") && !host.endsWith(".jtvnw.net")) {
        return false
      }
      if (/\.m3u8($|\?)/i.test(url)) return true
      if (/\.(ts|m4s|mp4|aac|cmfv|cmfa|cmft)($|\?)/i.test(url)) return true
      if (/video-weaver|playlist|segment|chunk/i.test(parsed.pathname)) return true
      return parsed.searchParams.has("token") || parsed.searchParams.has("sig")
    } catch {
      return false
    }
  }

  function isReactivePrefetchSite() {
    return isTwitchPageHost(location.hostname)
  }

  /**
   * On Twitch tabs the player must own every fetch/XHR (signed HLS + GQL).
   * Intercepting .m3u8 via extension-fetch caused AUTHZ_DISALLOWED_BITRATE.
   */
  function shouldPassthroughPlayerRequest(_url) {
    return isReactivePrefetchSite()
  }

  /** @deprecated use shouldPassthroughPlayerRequest on Twitch */
  function shouldPassthroughTwitchApi(url) {
    if (!isReactivePrefetchSite()) return false
    return shouldPassthroughPlayerRequest(url)
  }

  function isSmootherSkippedHost(hostname) {
    const host = normalizeHost(hostname)
    if (!host) return true
    return isTwitchPageHost(host)
  }

  /** Known media hosts where the fetch/XHR bridge should arm at document start. */
  function isMediaHost(hostname) {
    const host = normalizeHost(hostname)
    if (!host) return false
    return isTwitchPageHost(host)
  }

  /**
   * Generic browse pages (new tab, search home, etc.) defer the media bridge
   * until a video element appears or the background sends segment/cache work.
   */
  function shouldRunMediaBridge() {
    if (isReactivePrefetchSite()) return false
    return isMediaHost(location.hostname)
  }

  globalThis.AegisSitePolicy = {
    isTwitchPageHost,
    isTwitchMediaUrl,
    isReactivePrefetchSite,
    shouldPassthroughPlayerRequest,
    shouldPassthroughTwitchApi,
    isSmootherSkippedHost,
    isMediaHost,
    shouldRunMediaBridge
  }
})()
