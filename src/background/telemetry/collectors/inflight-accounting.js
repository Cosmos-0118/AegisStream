(() => {
  var ns = (self.AegisBackground ||= {})
  const { state, addLog } = ns

  const CATEGORIES = ["playback", "prefetch", "speculative", "rescue", "other"]

  function ensureInflightTelemetry() {
    if (!state.telemetry.inflightAudit) {
      state.telemetry.inflightAudit = {
        lastMismatchAt: 0,
        mismatchCount: 0
      }
    }
    return state.telemetry.inflightAudit
  }

  function classifyInflightCategory(meta = {}) {
    const source = String(meta.source || "").toLowerCase()
    const lane = String(meta.lane || "").toLowerCase()
    if (source.includes("rescue")) return "rescue"
    if (source.includes("speculative")) return "speculative"
    if (lane === "teleport" || /teleport|dom-seek|force-teleport|player-seek/.test(source)) {
      return "playback"
    }
    // quality-switch-warm / variant-switch are prefetch operations, not "other"
    if (/quality-switch|variant-switch|switch-warm/.test(source)) {
      return "prefetch"
    }
    if (/scrub|snap|velocity|schedule|bridge|chunk|maintenance|captured-playlist|playlist|manifest|delegate|visibility/.test(
      source
    )) {
      return "prefetch"
    }
    return "other"
  }

  function buildInflightCategoryCounts(tabId = null) {
    const counts = {
      playback: 0,
      prefetch: 0,
      speculative: 0,
      rescue: 0,
      other: 0,
      total: 0
    }
    for (const inflight of state.inflightPrefetches.values()) {
      if (Number.isFinite(tabId) && inflight?.tabId !== tabId) continue
      const category = inflight.category || classifyInflightCategory(inflight)
      if (counts[category] == null) counts.other += 1
      else counts[category] += 1
      counts.total += 1
    }
    return counts
  }

  function auditInflightAccounting(tabId = null) {
    const mapSize = Number.isFinite(tabId)
      ? (typeof ns.countInflightPrefetchesForTab === "function"
          ? ns.countInflightPrefetchesForTab(tabId)
          : buildInflightCategoryCounts(tabId).total)
      : state.inflightPrefetches.size
    const counts = buildInflightCategoryCounts(tabId)
    const sum =
      counts.playback +
      counts.prefetch +
      counts.speculative +
      counts.rescue +
      counts.other
    const ok = sum === mapSize
    return { ok, mapSize, sum, counts, tabId: tabId ?? null }
  }

  function formatInflightAccountingLine(tabId = null) {
    const audit = auditInflightAccounting(tabId)
    const label = Number.isFinite(tabId) ? `tab ${tabId}` : "global"
    const mismatch = audit.ok ? "" : ` MISMATCH(map=${audit.mapSize},sum=${audit.sum})`
    return (
      `inflight(${label}: total=${audit.mapSize}, playback=${audit.counts.playback}, ` +
      `prefetch=${audit.counts.prefetch}, speculative=${audit.counts.speculative}, ` +
      `rescue=${audit.counts.rescue}, other=${audit.counts.other})${mismatch}`
    )
  }

  function noteInflightMismatch(audit, context = "") {
    if (!audit || audit.ok) return
    const telemetry = ensureInflightTelemetry()
    const now = Date.now()
    telemetry.mismatchCount += 1
    if (now - telemetry.lastMismatchAt < 5_000) return
    telemetry.lastMismatchAt = now
    addLog(
      "WARN",
      `Inflight accounting mismatch${context ? ` (${context})` : ""}: map=${audit.mapSize}, categorySum=${audit.sum}, breakdown=p${audit.counts.playback}/f${audit.counts.prefetch}/s${audit.counts.speculative}/r${audit.counts.rescue}/o${audit.counts.other}`
    )
  }

  function attachInflightCategory(entry) {
    if (!entry || typeof entry !== "object") return entry
    entry.category = classifyInflightCategory(entry)
    return entry
  }

  ns.classifyInflightCategory = classifyInflightCategory
  ns.attachInflightCategory = attachInflightCategory
  ns.buildInflightCategoryCounts = buildInflightCategoryCounts
  ns.auditInflightAccounting = auditInflightAccounting
  ns.formatInflightAccountingLine = formatInflightAccountingLine
  ns.noteInflightMismatch = noteInflightMismatch
})()
