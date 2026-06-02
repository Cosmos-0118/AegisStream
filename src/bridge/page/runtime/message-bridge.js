(() => {
var ns = (self.AegisPageBridge ||= {})
const { prefetchSegmentsFromPage, pending } = ns

const knownSegments = new Set()

window.addEventListener("message", (event) => {
  if (event.source !== window) return
  const data = event.data
  if (!data || data.__aegisstream !== true) return

  // Receive known segment URLs from background
  if (data.type === "KNOWN_SEGMENTS" && data.urls) {
    for (const u of data.urls) {
      knownSegments.add(u.split("?")[0])
    }
    // Keep size reasonable to avoid memory leaks
    if (knownSegments.size > 2000) {
      const toDelete = Array.from(knownSegments).slice(0, 500)
      toDelete.forEach(k => knownSegments.delete(k))
    }
    return
  }

  // Handle prefetch commands from background (via content script)
  if (data.type === "PREFETCH_SEGMENTS" && data.urls) {
    void prefetchSegmentsFromPage(data.urls)
    return
  }

  // Handle response messages for pending requests
  if (!data.requestId || !pending.has(data.requestId)) return
  if (!data.type || !data.type.endsWith("_RESPONSE")) return
  const resolve = pending.get(data.requestId)
  pending.delete(data.requestId)
  resolve(data.response || { ok: false, hit: false })
})

ns.knownSegments = knownSegments
})()
