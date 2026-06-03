(() => {
var ns = (self.AegisBackground ||= {})

const DEFUSE_RULESET_ID = "aegis_defuse_rules"

function getHeaderValue(headers, name) {
  if (!Array.isArray(headers)) return ""
  const target = name.toLowerCase()
  for (const header of headers) {
    if ((header?.name || "").toLowerCase() === target) return header.value || ""
  }
  return ""
}

function isHtmlDocumentResponse(details) {
  if (details.statusCode !== 200) return false
  const contentType = getHeaderValue(details.responseHeaders, "content-type").toLowerCase()
  if (!contentType.includes("text/html")) return false
  const encoding = getHeaderValue(details.responseHeaders, "content-encoding").toLowerCase()
  if (encoding && encoding !== "identity" && encoding !== "none") return false
  return true
}

function shouldBoostDocumentStream(state, url) {
  if (!state?.settings?.enabled) return false
  if (state.settings.documentStreamBoost === false) return false
  if (typeof ns.isSkippableDocumentUrl === "function" && ns.isSkippableDocumentUrl(url)) {
    return false
  }
  return true
}

function installDocumentStreamHook() {
  if (ns.__documentStreamHookInstalled === true) return
  if (typeof chrome?.webRequest?.filterResponseData !== "function") return
  ns.__documentStreamHookInstalled = true

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const state = ns.state
      if (!shouldBoostDocumentStream(state, details.url)) return
      if (details.type !== "main_frame") return
      if (!isHtmlDocumentResponse(details)) return

      try {
        const filter = chrome.webRequest.filterResponseData(details.requestId)
        ns.attachHtmlStreamInjector(filter, details.url, (count, pageUrl, reason) => {
          if (typeof ns.addLog === "function") {
            ns.addLog(
              "DEBUG",
              `Early head injection (${reason || "ok"}): ${count} preload(s) for ${String(pageUrl).slice(0, 96)}`
            )
          }
        })
      } catch (e) {
        if (typeof ns.addLog === "function") {
          ns.addLog("WARN", `Document stream hook skipped: ${e.message}`)
        }
      }
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["responseHeaders"]
  )
}

async function syncCpuShieldRuleset(enabled) {
  if (typeof chrome.declarativeNetRequest?.updateEnabledRulesets !== "function") return
  try {
    if (enabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [DEFUSE_RULESET_ID],
        disableRulesetIds: []
      })
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: [],
        disableRulesetIds: [DEFUSE_RULESET_ID]
      })
    }
  } catch (e) {
    if (typeof ns.addLog === "function") {
      ns.addLog("WARN", `CPU shield ruleset sync failed: ${e.message}`)
    }
  }
}

function shouldEnableCpuShield(state) {
  return state?.settings?.enabled !== false && state?.settings?.cpuShieldEnabled !== false
}

async function syncPerformanceGemsFromSettings(state = ns.state) {
  await syncCpuShieldRuleset(shouldEnableCpuShield(state))
}

ns.DEFUSE_RULESET_ID = DEFUSE_RULESET_ID
ns.installDocumentStreamHook = installDocumentStreamHook
ns.syncPerformanceGemsFromSettings = syncPerformanceGemsFromSettings
})()
