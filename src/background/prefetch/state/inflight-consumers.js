(() => {
  var ns = (self.AegisBackground ||= {})
  const { state, addLog } = ns

  function normalizeInflightKey(url) {
    if (!url || typeof url !== "string") return null
    return typeof ns.resolvePrefetchCoalesceKey === "function"
      ? ns.resolvePrefetchCoalesceKey(url)
      : typeof ns.stripHash === "function"
        ? ns.stripHash(url)
        : url
  }

  function getInflightPrefetchEntry(url) {
    const key = normalizeInflightKey(url)
    if (!key) return null
    return state.inflightPrefetches.get(key) || null
  }

  function syncInflightAbortLock(entry) {
    if (!entry || typeof entry !== "object") return
    entry.abortLocked = (Number(entry.consumers) || 0) > 0
  }

  function attachInflightConsumer(url, tabId = null) {
    const key = normalizeInflightKey(url)
    if (!key) return 0
    const entry = state.inflightPrefetches.get(key)
    if (!entry) return 0
    if (Number.isFinite(tabId) && entry.tabId !== tabId) {
      return Number(entry.consumers) || 0
    }
    entry.consumers = (Number(entry.consumers) || 0) + 1
    entry.pendingRelease = false
    syncInflightAbortLock(entry)
    return entry.consumers
  }

  function releaseInflightConsumer(url, tabId = null) {
    const key = normalizeInflightKey(url)
    if (!key) return 0
    const entry = state.inflightPrefetches.get(key)
    if (!entry) return 0
    if (Number.isFinite(tabId) && entry.tabId !== tabId) {
      return Number(entry.consumers) || 0
    }
    entry.consumers = Math.max(0, (Number(entry.consumers) || 0) - 1)
    syncInflightAbortLock(entry)
    if (entry.consumers === 0 && entry.pendingRelease === true) {
      state.inflightPrefetches.delete(key)
    }
    return entry.consumers
  }

  function isInflightAbortLocked(url, tabId = null) {
    const entry = getInflightPrefetchEntry(url)
    if (!entry) return false
    if (Number.isFinite(tabId) && entry.tabId !== tabId) return false
    return (Number(entry.consumers) || 0) > 0
  }

  function tryReleaseInflightEntry(url, options = {}) {
    const key = normalizeInflightKey(url)
    if (!key) return false
    const entry = state.inflightPrefetches.get(key)
    if (!entry) return false
    if ((Number(entry.consumers) || 0) > 0) {
      entry.pendingRelease = options.defer !== false
      if (options.logPreserve !== false) {
        addLog(
          "DEBUG",
          `Preserving in-flight prefetch for ${String(url).slice(-48)} — ${entry.consumers} player consumer(s) attached`
        )
      }
      return false
    }
    state.inflightPrefetches.delete(key)
    return true
  }

  function mutateInflightConsumer(url, delta, tabId = null) {
    const amount = Number(delta)
    if (!Number.isFinite(amount) || amount === 0) return 0
    if (amount > 0) {
      let consumers = 0
      for (let i = 0; i < amount; i += 1) {
        consumers = attachInflightConsumer(url, tabId)
      }
      return consumers
    }
    let consumers = Number(getInflightPrefetchEntry(url)?.consumers) || 0
    for (let i = 0; i < Math.abs(amount); i += 1) {
      consumers = releaseInflightConsumer(url, tabId)
    }
    return consumers
  }

  ns.normalizeInflightKey = normalizeInflightKey
  ns.getInflightPrefetchEntry = getInflightPrefetchEntry
  ns.attachInflightConsumer = attachInflightConsumer
  ns.releaseInflightConsumer = releaseInflightConsumer
  ns.isInflightAbortLocked = isInflightAbortLocked
  ns.tryReleaseInflightEntry = tryReleaseInflightEntry
  ns.mutateInflightConsumer = mutateInflightConsumer
})()
