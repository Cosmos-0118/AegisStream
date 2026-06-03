(() => {
var ns = (self.AegisBackground ||= {})
const { state, bumpActivity } = ns

const STAT = {
  anchorCommitsNetwork: "anchorCommitsNetwork",
  anchorCommitsSeekPrediction: "anchorCommitsSeekPrediction",
  anchorCommitsDomSeeked: "anchorCommitsDomSeeked",
  teleportsHard: "teleportsHard",
  teleportsSoft: "teleportsSoft",
  monotonicBreakthroughs: "monotonicBreakthroughs",
  tokenRefreshRetentions: "tokenRefreshRetentions",
  anchorDeferred: "anchorDeferred",
  domSeekSkipped: "domSeekSkipped"
}

function recordAnchorCommit(authority, options = {}) {
  const teleport = options.teleport || null
  if (authority === ns.AnchorAuthority?.DOM_SEEKED) {
    bumpActivity(STAT.anchorCommitsDomSeeked, 1)
  } else if (authority === ns.AnchorAuthority?.SEEK_PREDICTION) {
    bumpActivity(STAT.anchorCommitsSeekPrediction, 1)
  } else {
    bumpActivity(STAT.anchorCommitsNetwork, 1)
  }
  if (teleport === "hard") bumpActivity(STAT.teleportsHard, 1)
  if (teleport === "soft") bumpActivity(STAT.teleportsSoft, 1)
}

function recordMonotonicBreakthrough() {
  bumpActivity(STAT.monotonicBreakthroughs, 1)
  bumpActivity(STAT.anchorCommitsNetwork, 1)
}

function recordTokenRefreshRetention() {
  bumpActivity(STAT.tokenRefreshRetentions, 1)
}

function recordAnchorDeferred() {
  bumpActivity(STAT.anchorDeferred, 1)
}

function recordDomSeekSkipped() {
  bumpActivity(STAT.domSeekSkipped, 1)
}

function recordTeleportHard() {
  bumpActivity(STAT.teleportsHard, 1)
}

function recordTeleportSoft() {
  bumpActivity(STAT.teleportsSoft, 1)
}

function getAnchorOwnershipSummary() {
  const s = state.stats || {}
  return {
    anchorCommits: {
      network: Number(s[STAT.anchorCommitsNetwork]) || 0,
      seekPrediction: Number(s[STAT.anchorCommitsSeekPrediction]) || 0,
      domSeeked: Number(s[STAT.anchorCommitsDomSeeked]) || 0
    },
    teleports: {
      hard: Number(s[STAT.teleportsHard]) || 0,
      soft: Number(s[STAT.teleportsSoft]) || 0
    },
    monotonicBreakthroughs: Number(s[STAT.monotonicBreakthroughs]) || 0,
    tokenRefreshRetentions: Number(s[STAT.tokenRefreshRetentions]) || 0,
    anchorDeferred: Number(s[STAT.anchorDeferred]) || 0,
    domSeekSkipped: Number(s[STAT.domSeekSkipped]) || 0
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
    `deferred=${data.anchorDeferred || 0}, domSkip=${data.domSeekSkipped || 0})`
  )
}

function resetAnchorTelemetry() {
  for (const key of Object.values(STAT)) {
    if (typeof state.stats[key] === "number") {
      state.stats[key] = 0
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
ns.getAnchorOwnershipSummary = getAnchorOwnershipSummary
ns.formatAnchorOwnershipLine = formatAnchorOwnershipLine
ns.resetAnchorTelemetry = resetAnchorTelemetry
})()
