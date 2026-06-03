/**
 * Page-world mirror of background manifest sequence helpers (MAIN world).
 */
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self
  const ns = (root.AegisPageBridge ||= {})

  function getManifestUrlSignature(url) {
    if (typeof url !== "string" || !url) return null
    try {
      const parsed = new URL(url, location.href)
      return `${parsed.origin}${parsed.pathname}`
    } catch {
      const stripped = url.split("#")[0].split("?")[0]
      return stripped || null
    }
  }

  ns.getManifestUrlSignature = getManifestUrlSignature
})()
