(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("asset-breaker")) {
  return
}

const { originalFetch, getRequestDetails, logBridge, smoother } = ns
if (!originalFetch || !getRequestDetails || !smoother?.isCriticalStaticAsset) return

const TIMEOUT_REASON = "aegis-circuit-timeout"

function mergeAbortSignals(userSignal, breakerSignal) {
  if (!userSignal) return breakerSignal
  if (userSignal.aborted) return userSignal
  const controller = new AbortController()
  const onAbort = () => controller.abort(userSignal.reason)
  userSignal.addEventListener("abort", onAbort, { once: true })
  breakerSignal.addEventListener("abort", () => controller.abort(breakerSignal.reason), {
    once: true
  })
  return controller.signal
}

function buildCacheBustInit(input, init, url) {
  const headers = new Headers(
    init?.headers || (input instanceof Request ? input.headers : undefined)
  )
  headers.set("Cache-Control", "no-cache, no-store, must-revalidate")
  headers.set("Pragma", "no-cache")
  return {
    ...init,
    headers,
    cache: "reload"
  }
}

function resolveBreakerTimeoutMs() {
  if (typeof smoother.getAdaptiveCircuitBreakerMs === "function") {
    return smoother.getAdaptiveCircuitBreakerMs()
  }
  return smoother.CIRCUIT_BREAKER_MS || 2500
}

async function fetchWithCircuitBreaker(input, init) {
  const { url, method } = getRequestDetails(input, init)
  if (!smoother.isCriticalStaticAsset(url, method)) {
    return originalFetch(input, init)
  }

  const breakerTimeoutMs = resolveBreakerTimeoutMs()
  const startedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now()

  const breakerController = new AbortController()
  const timeoutId = setTimeout(() => {
    breakerController.abort(TIMEOUT_REASON)
  }, breakerTimeoutMs)

  const racedInit = {
    ...init,
    signal: mergeAbortSignals(init?.signal, breakerController.signal)
  }

  try {
    const response = await originalFetch(input, racedInit)
    clearTimeout(timeoutId)
    if (
      response?.ok &&
      typeof smoother.recordCircuitBreakerSample === "function" &&
      typeof performance !== "undefined"
    ) {
      smoother.recordCircuitBreakerSample(performance.now() - startedAt)
    }
    return response
  } catch (err) {
    clearTimeout(timeoutId)
    const timedOut =
      breakerController.signal.aborted &&
      breakerController.signal.reason === TIMEOUT_REASON
    if (!timedOut) throw err

    const estimatedRtt =
      typeof smoother.getEstimatedRttMs === "function" ? smoother.getEstimatedRttMs() : null
    logBridge(
      `Asset circuit breaker tripped (${breakerTimeoutMs}ms budget, rtt~${estimatedRtt ?? "?"}ms): ${String(url).slice(0, 80)}`,
      "WARN"
    )
    if (typeof ns.reportRuntimeMetric === "function") {
      ns.reportRuntimeMetric("asset_circuit_breaker", {
        url: String(url).slice(0, 120),
        timeoutMs: breakerTimeoutMs,
        estimatedRttMs: estimatedRtt
      })
    }

    const bustUrl = smoother.appendCacheBust(url)
    const bustInit = buildCacheBustInit(input, init, bustUrl)
    const retryStartedAt =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now()
    const retryResponse = await originalFetch(bustUrl, {
      ...bustInit,
      signal: init?.signal
    })
    if (
      retryResponse?.ok &&
      typeof smoother.recordCircuitBreakerSample === "function" &&
      typeof performance !== "undefined"
    ) {
      smoother.recordCircuitBreakerSample(performance.now() - retryStartedAt)
    }
    return retryResponse
  }
}

ns.fetchWithCircuitBreaker = fetchWithCircuitBreaker
})()
