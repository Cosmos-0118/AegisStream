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

  const FLAGS_TO_FALSE = [
    "web_player_ump",
    "web_player_enable_ump",
    "web_player_ump_video_proxy",
    "web_player_unified_media_pipeline",
    "web_player_enable_unified_media_pipeline",
    "web_player_enable_modern_videoplayback_protocol"
  ]

  const FLAGS_TO_TRUE = [
    "html5_disable_media_engine_select_on_ump",
    "html5_web_player_vpb_playable_uses_mediasource"
  ]

  function applyFlagMutations(flags) {
    if (!flags || typeof flags !== "object") return 0
    let updates = 0

    for (const key of FLAGS_TO_FALSE) {
      if (flags[key] !== false) {
        flags[key] = false
        updates += 1
      }
    }

    for (const key of FLAGS_TO_TRUE) {
      if (flags[key] !== true) {
        flags[key] = true
        updates += 1
      }
    }

    return updates
  }

  function patchSerializedFlags(serialized) {
    if (typeof serialized !== "string" || !serialized) return { value: serialized, updates: 0 }

    const map = new Map()
    for (const pair of serialized.split("&").filter(Boolean)) {
      const idx = pair.indexOf("=")
      if (idx === -1) {
        map.set(pair, "true")
      } else {
        map.set(pair.slice(0, idx), pair.slice(idx + 1))
      }
    }

    let updates = 0
    for (const key of FLAGS_TO_FALSE) {
      if (map.get(key) !== "false") {
        map.set(key, "false")
        updates += 1
      }
    }
    for (const key of FLAGS_TO_TRUE) {
      if (map.get(key) !== "true") {
        map.set(key, "true")
        updates += 1
      }
    }

    const value = Array.from(map.entries())
      .map(([key, val]) => `${key}=${val}`)
      .join("&")

    return { value, updates }
  }

  function patchConfig(config) {
    if (!config || typeof config !== "object") return 0
    let updates = 0

    updates += applyFlagMutations(config)
    updates += applyFlagMutations(config.EXPERIMENT_FLAGS)
    updates += applyFlagMutations(config.EXPERIMENTS_FORCED_FLAGS)

    const contexts = config.WEB_PLAYER_CONTEXT_CONFIGS
    if (contexts && typeof contexts === "object") {
      for (const value of Object.values(contexts)) {
        if (!value || typeof value !== "object") continue
        updates += applyFlagMutations(value.EXPERIMENT_FLAGS)
        updates += applyFlagMutations(value.experimentFlags)

        if (typeof value.serializedExperimentFlags === "string") {
          const patched = patchSerializedFlags(value.serializedExperimentFlags)
          if (patched.updates > 0 && patched.value !== value.serializedExperimentFlags) {
            value.serializedExperimentFlags = patched.value
            updates += patched.updates
          }
        }
      }
    }

    return updates
  }

  function patchYtCfgObject(ytcfgObject) {
    if (!ytcfgObject || typeof ytcfgObject !== "object") return 0
    let updates = 0

    updates += patchConfig(ytcfgObject)
    updates += patchConfig(ytcfgObject.data_)

    if (typeof ytcfgObject.get === "function") {
      try {
        updates += applyFlagMutations(ytcfgObject.get("EXPERIMENT_FLAGS"))
        updates += applyFlagMutations(ytcfgObject.get("EXPERIMENTS_FORCED_FLAGS"))
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
