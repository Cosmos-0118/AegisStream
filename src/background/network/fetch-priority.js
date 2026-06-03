(() => {
var ns = (self.AegisBackground ||= {})

const SPECULATIVE_SOURCE_RE =
  /prefetch|speculative|teleport|snap-back|chunk-observed|bridge-ready|maintenance/i

function isSpeculativeFetchSource(source) {
  return SPECULATIVE_SOURCE_RE.test(String(source || ""))
}

/**
 * Network scheduling weight for extension / orchestrator fetches.
 * Player-critical work stays at default; speculative prefetch uses low priority.
 */
function resolveFetchPriority(options = {}) {
  if (options.priority === "high" || options.priority === "low" || options.priority === "auto") {
    return options.priority
  }
  if (options.isScrubbingTrainActive === true || options.bufferTier === "emergency") {
    return "high"
  }
  if (isSpeculativeFetchSource(options.source)) {
    return "low"
  }
  return "auto"
}

ns.isSpeculativeFetchSource = isSpeculativeFetchSource
ns.resolveFetchPriority = resolveFetchPriority
})()
