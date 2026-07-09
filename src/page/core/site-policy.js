(() => {
  if (globalThis.AegisSitePolicy) return

  const TWITCH_PAGE_HOST_SUFFIXES = [".twitch.tv"]

  /**
   * Third-party players we can never accelerate: proprietary signed/DASH
   * delivery (YouTube/googlevideo) or redirector shells that just embed one
   * (Blogger's legacy video.g). No HLS/segment playlist ever reaches us here,
   * so intercepting fetch/XHR only adds overhead and risks breaking their
   * own signed requests — treat like Twitch, full passthrough.
   */
  const NON_ACCELERATABLE_EMBED_HOSTS = new Set([
    "youtube.com",
    "youtube-nocookie.com",
    "googlevideo.com",
    "ytimg.com",
    "blogger.com",
    "blogspot.com"
  ])
  const NON_ACCELERATABLE_EMBED_HOST_SUFFIXES = [
    ".youtube.com",
    ".youtube-nocookie.com",
    ".googlevideo.com",
    ".ytimg.com",
    ".blogger.com",
    ".blogspot.com"
  ]

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

  function isNonAcceleratableEmbedHost(hostname) {
    const host = normalizeHost(hostname)
    if (!host) return false
    if (NON_ACCELERATABLE_EMBED_HOSTS.has(host)) return true
    return NON_ACCELERATABLE_EMBED_HOST_SUFFIXES.some((suffix) => hostMatchesSuffix(host, suffix))
  }

  /** Frames where AegisStream should never touch fetch/XHR/prefetch/buffer monitoring. */
  function shouldFullyPassthroughFrame() {
    return isReactivePrefetchSite() || isNonAcceleratableEmbedHost(location.hostname)
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
    return isTwitchPageHost(host) || isNonAcceleratableEmbedHost(host)
  }

  /** Known media hosts where the fetch/XHR bridge should arm at document start. */
  function isMediaHost(hostname) {
    const host = normalizeHost(hostname)
    if (!host) return false
    // Twitch is handled via isReactivePrefetchSite (never intercept).
    // Generic anime/HLS hosts arm from playback-context heuristics instead.
    return false
  }

  /**
   * Watch pages and player embeds need fetch/XHR hooks before the first m3u8
   * lands — otherwise PLAYLIST_CONTENT never reaches the service worker.
   * Cross-origin iframe players are the common case for anime sites.
   */
  function isLikelyPlaybackContext() {
    try {
      if (typeof window !== "undefined" && window.top !== window) return true
    } catch {
      // Cross-origin parent access throws — still an embedded frame.
      return true
    }
    try {
      const path = String(location.pathname || "")
      if (
        /\/(watch|embed|player|episode|video|stream|play|anime|manga)\b/i.test(path) ||
        /\/ep[-_/]?\d+/i.test(path) ||
        /\/(hls|m3u8|manifest)\b/i.test(path)
      ) {
        return true
      }
    } catch {
      // ignore
    }
    return false
  }

  /**
   * Generic browse pages (new tab, search home, etc.) defer the media bridge
   * until a video element appears or the background sends segment/cache work.
   * Watch/embed contexts arm immediately so playlist capture can run.
   */
  function shouldRunMediaBridge() {
    if (shouldFullyPassthroughFrame()) return false
    return isMediaHost(location.hostname) || isLikelyPlaybackContext()
  }

  globalThis.AegisSitePolicy = {
    isTwitchPageHost,
    isTwitchMediaUrl,
    isReactivePrefetchSite,
    isNonAcceleratableEmbedHost,
    shouldFullyPassthroughFrame,
    shouldPassthroughPlayerRequest,
    shouldPassthroughTwitchApi,
    isSmootherSkippedHost,
    isMediaHost,
    isLikelyPlaybackContext,
    shouldRunMediaBridge
  }
})()
