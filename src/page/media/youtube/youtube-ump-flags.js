// Shared YouTube experiment-flag patches (kill-ump + network response patching).
(() => {
  if (globalThis.AegisYouTubeFlags) return

  const FLAGS_TO_FALSE = [
    "web_player_ump",
    "web_player_enable_ump",
    "web_player_ump_video_proxy",
    "web_player_unified_media_pipeline",
    "web_player_enable_unified_media_pipeline",
    "web_player_enable_modern_videoplayback_protocol",
    "html5_use_ump",
    "html5_enable_ump",
    "enable_ump",
    "player_ump"
  ]

  const FLAGS_TO_TRUE = [
    "html5_disable_media_engine_select_on_ump",
    "html5_web_player_vpb_playable_uses_mediasource",
    "html5_enable_media_source",
    "html5_enable_media_source_attach"
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

  function patchConfig(config, depth = 0) {
    if (!config || typeof config !== "object" || depth > 8) return 0
    let updates = 0

    updates += applyFlagMutations(config)
    updates += applyFlagMutations(config.EXPERIMENT_FLAGS)
    updates += applyFlagMutations(config.EXPERIMENTS_FORCED_FLAGS)
    updates += applyFlagMutations(config.experimentFlags)

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

    if (Array.isArray(config)) {
      for (const item of config) {
        updates += patchConfig(item, depth + 1)
      }
      return updates
    }

    for (const value of Object.values(config)) {
      if (!value || typeof value !== "object") continue
      if (
        value === config.EXPERIMENT_FLAGS ||
        value === config.EXPERIMENTS_FORCED_FLAGS ||
        value === config.WEB_PLAYER_CONTEXT_CONFIGS
      ) {
        continue
      }
      updates += patchConfig(value, depth + 1)
    }

    return updates
  }

  globalThis.AegisYouTubeFlags = {
    FLAGS_TO_FALSE,
    FLAGS_TO_TRUE,
    applyFlagMutations,
    patchSerializedFlags,
    patchConfig
  }
})()
