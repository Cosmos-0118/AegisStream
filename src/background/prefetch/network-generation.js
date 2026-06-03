(() => {
  var ns = (self.AegisBackground ||= {})
  const { addLog } = ns

  function ensurePrefetchRegistry(tabState) {
    if (!tabState) return new Set()
    if (!(tabState.prefetchDownloadRegistry instanceof Set)) {
      tabState.prefetchDownloadRegistry = new Set()
    }
    return tabState.prefetchDownloadRegistry
  }

  function prefetchRegistryKey(tabState, normalizedUrl) {
    const gen = Number(tabState?.networkGeneration) || 0
    return `${gen}|${normalizedUrl}`
  }

  function bumpNetworkGeneration(tabId, tabState, reason) {
    if (!tabState) return 0
    const next = (Number(tabState.networkGeneration) || 0) + 1
    tabState.networkGeneration = next
    ensurePrefetchRegistry(tabState).clear()
    addLog(
      "DEBUG",
      `Network generation ${next} on tab ${tabId}${reason ? ` (${reason})` : ""}`
    )
    return next
  }

  function isCurrentNetworkGeneration(tabState, generation) {
    if (!tabState) return false
    const msgGen = Number(generation)
    if (!Number.isFinite(msgGen)) return true
    return msgGen === Number(tabState.networkGeneration) || 0
  }

  function tryRegisterPrefetchDownload(tabState, normalizedUrl) {
    if (!tabState || !normalizedUrl) return false
    const key = prefetchRegistryKey(tabState, normalizedUrl)
    const registry = ensurePrefetchRegistry(tabState)
    if (registry.has(key)) return false
    registry.add(key)
    return true
  }

  function releasePrefetchDownload(tabState, normalizedUrl) {
    if (!tabState || !normalizedUrl) return
    const key = prefetchRegistryKey(tabState, normalizedUrl)
    tabState.prefetchDownloadRegistry?.delete(key)
  }

  ns.bumpNetworkGeneration = bumpNetworkGeneration
  ns.isCurrentNetworkGeneration = isCurrentNetworkGeneration
  ns.tryRegisterPrefetchDownload = tryRegisterPrefetchDownload
  ns.releasePrefetchDownload = releasePrefetchDownload
  ns.prefetchRegistryKey = prefetchRegistryKey
})()
