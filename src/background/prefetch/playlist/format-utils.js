(() => {
var ns = (self.AegisBackground ||= {})

ns.formatPlaylistUrlTail = function formatPlaylistUrlTail(url) {
  if (!url || typeof url !== "string") return "(none)"
  const normalized = typeof ns.stripHash === "function" ? (ns.stripHash(url) || url) : url
  return normalized.length > 96 ? normalized.slice(-96) : normalized
}
})()
