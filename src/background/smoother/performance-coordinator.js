(() => {
var ns = (self.AegisBackground ||= {})

/**
 * Syncs independent page-performance pipelines in parallel from one settings snapshot.
 * Per-request pipelines (document stream boost, header early hints) stay gated inside their hooks.
 */
async function syncAllPerformancePipelinesFromSettings(state = ns.state) {
  const tasks = []

  if (typeof ns.syncTelemetryDefuserFromSettings === "function") {
    tasks.push(ns.syncTelemetryDefuserFromSettings(state))
  }
  if (typeof ns.syncBfcacheHealerFromSettings === "function") {
    tasks.push(ns.syncBfcacheHealerFromSettings(state))
  }

  const results = await Promise.allSettled(tasks)
  for (const result of results) {
    if (result.status === "rejected" && typeof ns.addLog === "function") {
      ns.addLog("WARN", `Performance pipeline sync failed: ${result.reason?.message || result.reason}`)
    }
  }
}

function shouldEnableDocumentStreamBoost(state) {
  return state?.settings?.enabled !== false && state?.settings?.documentStreamBoost !== false
}

function shouldEnableHeaderEarlyHints(state) {
  return state?.settings?.enabled !== false && state?.settings?.headerEarlyHints !== false
}

ns.syncAllPerformancePipelinesFromSettings = syncAllPerformancePipelinesFromSettings
ns.shouldEnableDocumentStreamBoost = shouldEnableDocumentStreamBoost
ns.shouldEnableHeaderEarlyHints = shouldEnableHeaderEarlyHints
})()
