(() => {
  var ns = (self.AegisPageBridge ||= {})

  /**
   * Build a structured prefetch failure payload for the background log pipeline.
   */
  function buildPrefetchFailureResult(url, details = {}) {
    const status = Number.isFinite(Number(details.status)) ? Number(details.status) : 0
    const errorName =
      typeof details.errorName === "string" && details.errorName ? details.errorName : null
    const errorMessage = String(details.errorMessage || details.error || "unknown")
    const fetchPath = details.fetchPath || "originalFetch"
    const fetchMode = details.fetchMode || "page"

    let error = errorMessage
    if (status > 0) {
      error = `HTTP ${status}: ${errorMessage}`
    } else if (errorName) {
      error = `${errorName}: ${errorMessage}`
    }

    return {
      url,
      success: false,
      fetchMode,
      fetchPath,
      status,
      errorName,
      errorMessage,
      error,
      networkGeneration: Number.isFinite(Number(details.networkGeneration))
        ? Number(details.networkGeneration)
        : null,
      transient: details.transient === true,
      authFailure:
        details.authFailure === true || status === 401 || status === 403,
      rateLimit: details.rateLimit === true || status === 429
    }
  }

  ns.buildPrefetchFailureResult = buildPrefetchFailureResult
})()
