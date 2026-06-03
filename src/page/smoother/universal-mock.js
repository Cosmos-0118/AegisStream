/**
 * Universal deep no-op proxy for telemetry globals (CPU shield page bridge).
 * Runs in MAIN world at document_start before host scripts execute.
 */
;(() => {
  "use strict"
  if (typeof window === "undefined") return
  if (window.__AEGIS_UNIVERSAL_MOCK_INSTALLED__ === true) return
  window.__AEGIS_UNIVERSAL_MOCK_INSTALLED__ = true

  const TRACKERS_TIER1 = ["hj", "hjt", "clarity", "_clarity", "_satellite", "satellite"]
  const TRACKERS_AGGRESSIVE = [
    "mixpanel",
    "amplitude",
    "ga",
    "gtag",
    "google_tag_manager",
    "GoogleAnalyticsObject",
    "dataLayer",
    "analytics",
    "Intercom",
    "intercom"
  ]

  function createNoOpProxy() {
    const noOp = function noOp() {}

    const handler = {
      get(_target, prop) {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === "then") {
          return (resolve) => {
            if (typeof resolve === "function") resolve(createNoOpProxy())
          }
        }
        if (prop === "length") return 0
        if (prop === "toString" || prop === "valueOf") return () => ""
        if (prop === Symbol.toStringTag) return "Object"
        if (prop === "constructor") {
          return function NoOpConstructor() {
            return createNoOpProxy()
          }
        }
        return createNoOpProxy()
      },
      apply() {
        return createNoOpProxy()
      },
      construct() {
        return createNoOpProxy()
      },
      has() {
        return true
      }
    }

    return new Proxy(noOp, handler)
  }

  function defuseTracker(name) {
    if (!name) return
    if (name in window && window[name] != null) return
    try {
      Object.defineProperty(window, name, {
        value: createNoOpProxy(),
        writable: true,
        configurable: true,
        enumerable: true
      })
    } catch {
      try {
        window[name] = createNoOpProxy()
      } catch {
        // ignore
      }
    }
  }

  const aggressive = globalThis.__AEGIS_DEFUSE_AGGRESSIVE__ === true
  const seen = new Set()
  for (const tracker of TRACKERS_TIER1) {
    if (seen.has(tracker)) continue
    seen.add(tracker)
    defuseTracker(tracker)
  }
  if (aggressive) {
    for (const tracker of TRACKERS_AGGRESSIVE) {
      if (seen.has(tracker)) continue
      seen.add(tracker)
      defuseTracker(tracker)
    }
  }

  if (typeof globalThis.AegisUniversalMock !== "object") {
    globalThis.AegisUniversalMock = { createNoOpProxy, defuseTracker }
  }
})()
