// ---------------------------------------------------------------------------
// AegisStream YouTube Protocol Fallback
// Runs at document_start in MAIN world to reduce UMP usage by forcing
// experiment flags toward range/sq-friendly paths when YouTube allows it.
// ---------------------------------------------------------------------------

(() => {
  const host = location.hostname || ""
  if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return
  if (window.__aegisKillUmpInstalled) return
  window.__aegisKillUmpInstalled = true

  const flags = globalThis.AegisYouTubeFlags
  if (!flags) {
    console.warn("[AegisStream] YouTube flag patch module missing")
    return
  }

  const { patchConfig } = flags

  function patchYtCfgObject(ytcfgObject) {
    if (!ytcfgObject || typeof ytcfgObject !== "object") return 0
    let updates = 0

    updates += patchConfig(ytcfgObject)
    updates += patchConfig(ytcfgObject.data_)

    if (typeof ytcfgObject.get === "function") {
      try {
        updates += flags.applyFlagMutations(ytcfgObject.get("EXPERIMENT_FLAGS"))
        updates += flags.applyFlagMutations(ytcfgObject.get("EXPERIMENTS_FORCED_FLAGS"))
      } catch {
        // ignore
      }
    }

    if (typeof ytcfgObject.set === "function" && !ytcfgObject.__aegisUmpSetPatched) {
      const originalSet = ytcfgObject.set.bind(ytcfgObject)
      ytcfgObject.set = function patchedSet(...args) {
        for (const arg of args) {
          patchConfig(arg)
        }
        return originalSet(...args)
      }
      ytcfgObject.__aegisUmpSetPatched = true
      updates += 1
    }

    return updates
  }

  let appliedUpdates = patchYtCfgObject(window.ytcfg)

  const descriptor = Object.getOwnPropertyDescriptor(window, "ytcfg")
  if (!descriptor || descriptor.configurable) {
    let internalYtcfg = window.ytcfg
    try {
      Object.defineProperty(window, "ytcfg", {
        configurable: true,
        enumerable: true,
        get() {
          return internalYtcfg
        },
        set(value) {
          internalYtcfg = value
          appliedUpdates += patchYtCfgObject(value)
        }
      })
    } catch {
      // ignore
    }
  }

  document.addEventListener("yt-page-data-updated", () => {
    appliedUpdates += patchYtCfgObject(window.ytcfg)
  })

  if (appliedUpdates > 0) {
    const message = `Applied YouTube fallback flag patches (${appliedUpdates})`
    window.__aegisKillUmpStatus = message
    console.info(`[AegisStream] ${message}`)
  } else {
    const message = "YouTube fallback flag patch installed"
    window.__aegisKillUmpStatus = message
    console.info(`[AegisStream] ${message}`)
  }
})()
