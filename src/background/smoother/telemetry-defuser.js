(() => {
var ns = (self.AegisBackground ||= {})

const DEFUSE_RULESET_ID = "aegis_defuse_rules"
const DEFUSE_AGGRESSIVE_RULESET_ID = "aegis_defuse_aggressive_rules"
const CONTENT_SCRIPT_ID = "aegis-telemetry-defuser"

const YOUTUBE_EXCLUDE = ["*://youtube.com/*", "*://*.youtube.com/*"]

const STANDARD_DEFUSER_JS = [
  "src/page/smoother/mock/universal-mock-prelude-standard.js",
  "src/page/smoother/mock/universal-mock.js"
]

const AGGRESSIVE_DEFUSER_JS = [
  "src/page/smoother/mock/universal-mock-prelude-aggressive.js",
  "src/page/smoother/mock/universal-mock.js"
]

async function unregisterTelemetryDefuserScript() {
  if (typeof chrome.scripting?.unregisterContentScripts !== "function") return
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] })
  } catch {
    // ignore — not registered yet
  }
}

async function registerTelemetryDefuserScript(aggressive) {
  if (typeof chrome.scripting?.registerContentScripts !== "function") return
  await unregisterTelemetryDefuserScript()
  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: aggressive ? AGGRESSIVE_DEFUSER_JS : STANDARD_DEFUSER_JS,
      matches: ["<all_urls>"],
      excludeMatches: YOUTUBE_EXCLUDE,
      runAt: "document_start",
      world: "MAIN"
    }
  ])
}

async function syncDefuseRuleset(rulesetId, enabled) {
  if (typeof chrome.declarativeNetRequest?.updateEnabledRulesets !== "function") return
  try {
    if (enabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [rulesetId],
        disableRulesetIds: []
      })
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [],
        disableRulesetIds: [rulesetId]
      })
    }
  } catch (e) {
    if (typeof ns.addLog === "function") {
      ns.addLog("WARN", `Defuse ruleset sync failed (${rulesetId}): ${e.message}`)
    }
  }
}

function shouldEnableCpuShield(state) {
  return state?.settings?.enabled !== false && state?.settings?.cpuShieldEnabled !== false
}

function shouldEnableAggressiveDefuser(state) {
  return shouldEnableCpuShield(state) && state?.settings?.aggressiveScriptDefuserEnabled === true
}

async function syncTelemetryDefuserFromSettings(state = ns.state) {
  const cpuShield = shouldEnableCpuShield(state)
  const aggressive = shouldEnableAggressiveDefuser(state)

  if (cpuShield) {
    await registerTelemetryDefuserScript(aggressive)
  } else {
    await unregisterTelemetryDefuserScript()
  }

  await syncDefuseRuleset(DEFUSE_RULESET_ID, cpuShield)
  await syncDefuseRuleset(DEFUSE_AGGRESSIVE_RULESET_ID, aggressive)
}

ns.DEFUSE_RULESET_ID = DEFUSE_RULESET_ID
ns.DEFUSE_AGGRESSIVE_RULESET_ID = DEFUSE_AGGRESSIVE_RULESET_ID
ns.syncTelemetryDefuserFromSettings = syncTelemetryDefuserFromSettings
})()
