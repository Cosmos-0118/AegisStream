(() => {
var ns = (self.AegisBackground ||= {})

function bump(metric, amount = 1) {
  if (typeof ns.bumpActivity === "function") {
    ns.bumpActivity(metric, amount)
  }
}

const STAT = {
  anchorCommitsNetwork: "anchorCommitsNetwork",
  anchorCommitsSeekPrediction: "anchorCommitsSeekPrediction",
  anchorCommitsDomSeeked: "anchorCommitsDomSeeked",
  teleportsHard: "teleportsHard",
  teleportsSoft: "teleportsSoft",
  monotonicBreakthroughs: "monotonicBreakthroughs",
  tokenRefreshRetentions: "tokenRefreshRetentions",
  anchorDeferred: "anchorDeferred",
  domSeekSkipped: "domSeekSkipped",
  variantSwitchCascadeBlocked: "variantSwitchCascadeBlocked",
  domAnchorSupremacyPreserved: "domAnchorSupremacyPreserved"
}

function recordAnchorCommit(authority, options = {}) {
  const teleport = options.teleport || null
  if (authority === ns.AnchorAuthority?.DOM_SEEKED) {
    bump(STAT.anchorCommitsDomSeeked, 1)
  } else if (authority === ns.AnchorAuthority?.SEEK_PREDICTION) {
    bump(STAT.anchorCommitsSeekPrediction, 1)
  } else {
    bump(STAT.anchorCommitsNetwork, 1)
  }
  if (teleport === "hard") bump(STAT.teleportsHard, 1)
  if (teleport === "soft") bump(STAT.teleportsSoft, 1)
}

function recordMonotonicBreakthrough() {
  bump(STAT.monotonicBreakthroughs, 1)
  bump(STAT.anchorCommitsNetwork, 1)
}

function recordTokenRefreshRetention() {
  bump(STAT.tokenRefreshRetentions, 1)
}

function recordAnchorDeferred() {
  bump(STAT.anchorDeferred, 1)
}

function recordDomSeekSkipped() {
  bump(STAT.domSeekSkipped, 1)
}

function recordTeleportHard() {
  bump(STAT.teleportsHard, 1)
}

function recordTeleportSoft() {
  bump(STAT.teleportsSoft, 1)
}

function recordVariantSwitchCascadeBlocked() {
  bump(STAT.variantSwitchCascadeBlocked, 1)
}

function recordDomAnchorSupremacyPreserved() {
  bump(STAT.domAnchorSupremacyPreserved, 1)
}

function readMetric(name) {
  const s = ns.state?.stats || {}
  let total = Number(s[name]) || 0
  if (typeof ns.sumWindowCounters === "function") {
    const windowTotals = ns.sumWindowCounters()
    total = Math.max(total, Number(windowTotals[name]) || 0)
  }
  return total
}

function getAnchorOwnershipSummary() {
  return {
    anchorCommits: {
      network: readMetric(STAT.anchorCommitsNetwork),
      seekPrediction: readMetric(STAT.anchorCommitsSeekPrediction),
      domSeeked: readMetric(STAT.anchorCommitsDomSeeked)
    },
    teleports: {
      hard: readMetric(STAT.teleportsHard),
      soft: readMetric(STAT.teleportsSoft)
    },
    monotonicBreakthroughs: readMetric(STAT.monotonicBreakthroughs),
    tokenRefreshRetentions: readMetric(STAT.tokenRefreshRetentions),
    anchorDeferred: readMetric(STAT.anchorDeferred),
    domSeekSkipped: readMetric(STAT.domSeekSkipped),
    variantSwitchCascadeBlocked: readMetric(STAT.variantSwitchCascadeBlocked),
    domAnchorSupremacyPreserved: readMetric(STAT.domAnchorSupremacyPreserved)
  }
}

function formatAnchorOwnershipLine(summary = null) {
  const data = summary || getAnchorOwnershipSummary()
  const commits = data.anchorCommits || {}
  const teleports = data.teleports || {}
  return (
    `anchor(net=${commits.network || 0}/pred=${commits.seekPrediction || 0}/dom=${commits.domSeeked || 0}, ` +
    `teleport hard=${teleports.hard || 0}/soft=${teleports.soft || 0}, ` +
    `mono=${data.monotonicBreakthroughs || 0}, tokenRetain=${data.tokenRefreshRetentions || 0}, ` +
    `deferred=${data.anchorDeferred || 0}, domSkip=${data.domSkip || 0}, ` +
    `variantBlock=${data.variantSwitchCascadeBlocked || 0}, domSupreme=${data.domAnchorSupremacyPreserved || 0})`
  )
}

function resetAnchorTelemetry() {
  const stats = ns.state?.stats
  if (!stats) return
  for (const key of Object.values(STAT)) {
    if (typeof stats[key] === "number") {
      stats[key] = 0
    }
  }
}

ns.recordAnchorCommit = recordAnchorCommit
ns.recordMonotonicBreakthrough = recordMonotonicBreakthrough
ns.recordTokenRefreshRetention = recordTokenRefreshRetention
ns.recordAnchorDeferred = recordAnchorDeferred
ns.recordDomSeekSkipped = recordDomSeekSkipped
ns.recordTeleportHard = recordTeleportHard
ns.recordTeleportSoft = recordTeleportSoft
ns.recordVariantSwitchCascadeBlocked = recordVariantSwitchCascadeBlocked
ns.recordDomAnchorSupremacyPreserved = recordDomAnchorSupremacyPreserved
ns.getAnchorOwnershipSummary = getAnchorOwnershipSummary
ns.formatAnchorOwnershipLine = formatAnchorOwnershipLine
ns.resetAnchorTelemetry = resetAnchorTelemetry
})()
