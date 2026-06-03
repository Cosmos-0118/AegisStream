(() => {
var ns = (self.AegisBackground ||= {})

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
  if (typeof ns.shouldEnableDocumentStreamBoost === "function") {
    if (!ns.shouldEnableDocumentStreamBoost(state)) return false
  } else if (!state?.settings?.enabled || state.settings.documentStreamBoost === false) {
    return false
  }
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

async function syncPerformanceGemsFromSettings(state = ns.state) {
  if (typeof ns.syncAllPerformancePipelinesFromSettings === "function") {
    await ns.syncAllPerformancePipelinesFromSettings(state)
  }
}

ns.installDocumentStreamHook = installDocumentStreamHook
ns.syncPerformanceGemsFromSettings = syncPerformanceGemsFromSettings
})()
