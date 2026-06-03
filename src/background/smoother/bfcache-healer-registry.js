(() => {
var ns = (self.AegisBackground ||= {})

const CONTENT_SCRIPT_ID = "aegis-bfcache-healer"
const BFCACHE_HEALER_JS = ["src/page/smoother/navigation/bfcache-healer.js"]

const YOUTUBE_EXCLUDE = ["*://youtube.com/*", "*://*.youtube.com/*"]

function shouldEnableBfcacheHealer(state) {
  return state?.settings?.enabled !== false && state?.settings?.bfcacheEnforcerEnabled !== false
}

async function unregisterBfcacheHealerScript() {
  if (typeof chrome.scripting?.unregisterContentScripts !== "function") return
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] })
  } catch {
    // ignore
  }
}

async function registerBfcacheHealerScript() {
  if (typeof chrome.scripting?.registerContentScripts !== "function") return
  await unregisterBfcacheHealerScript()
  await chrome.scripting.registerContentScripts([
    {
      id: CONTENT_SCRIPT_ID,
      js: BFCACHE_HEALER_JS,
      matches: ["<all_urls>"],
      excludeMatches: YOUTUBE_EXCLUDE,
      runAt: "document_start",
      world: "MAIN"
    }
  ])
}

async function syncBfcacheHealerFromSettings(state = ns.state) {
  if (shouldEnableBfcacheHealer(state)) {
    await registerBfcacheHealerScript()
  } else {
    await unregisterBfcacheHealerScript()
  }
}

ns.syncBfcacheHealerFromSettings = syncBfcacheHealerFromSettings
})()
