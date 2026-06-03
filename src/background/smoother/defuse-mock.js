/**
 * No-op substitute for heavy third-party telemetry scripts (CPU shield).
 * Keeps the host page from throwing load errors while reclaiming main-thread time.
 */
;(() => {
  "use strict"
  if (typeof window === "undefined") return
  try {
    window.dispatchEvent(new Event("load"))
  } catch {
    // ignore
  }
})()
