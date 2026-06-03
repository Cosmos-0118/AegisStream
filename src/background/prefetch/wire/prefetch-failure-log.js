(() => {
  var ns = (self.AegisBackground ||= {})
  const { state, stripHash, resolveSegmentIndexInManifest } = ns

  function resolvePrefetchSegmentIndex(tabId, url) {
    if (!Number.isFinite(tabId) || !url) return null
    const tabState = state.playlistByTab.get(tabId)
    if (!tabState?.signatureToIndex) return null
    const normalized = typeof stripHash === "function" ? stripHash(url) : url
    const idx = resolveSegmentIndexInManifest(normalized, tabState)
    return typeof idx === "number" ? idx : null
  }

  function formatPrefetchFailureLogLine(tabId, message, outcome) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((Number(outcome?.retryAfter || 0) - Date.now()) / 1000)
    )
    const segmentIndex = resolvePrefetchSegmentIndex(tabId, message?.url)
    const segmentLabel = typeof segmentIndex === "number" ? String(segmentIndex) : "?"
    const mode = message?.fetchMode || "page"
    const path = message?.fetchPath || "originalFetch"
    const status = Number.isFinite(Number(message?.status)) ? Number(message.status) : 0
    const name =
      typeof message?.errorName === "string" && message.errorName
        ? message.errorName
        : ""
    const msg = message?.errorMessage || message?.error || "unknown"
    const urlTail = (message?.url || "").slice(-80)
    const namePart = name ? ` name=${name}` : ""
    return (
      `Prefetch failed (attempt ${outcome?.attempts || 1}, retry in ${retryAfterSec}s): ` +
      `segment=${segmentLabel} mode=${mode} path=${path} status=${status}${namePart} ` +
      `msg=${msg} — ${urlTail}`
    )
  }

  function summarizePrefetchErrorForFsm(message) {
    const status = Number(message?.status) || 0
    if (status === 401 || status === 403) return `HTTP ${status}`
    if (status === 429) return "HTTP 429"
    if (status > 0) return `HTTP ${status}`
    if (message?.errorName) return `${message.errorName}: ${message.errorMessage || message.error || ""}`
    return message?.errorMessage || message?.error || "unknown"
  }

  ns.formatPrefetchFailureLogLine = formatPrefetchFailureLogLine
  ns.summarizePrefetchErrorForFsm = summarizePrefetchErrorForFsm
  ns.resolvePrefetchSegmentIndex = resolvePrefetchSegmentIndex
})()
