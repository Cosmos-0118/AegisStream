(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

const AnchorAuthority = {
  NETWORK: 1,
  SEEK_PREDICTION: 2,
  DOM_SEEKED: 3
}

function anchorJump(tabState, targetIndex) {
  const current = tabState?.hasAnchor ? tabState.anchorIndex : null
  if (typeof current !== "number") return Number.POSITIVE_INFINITY
  if (typeof targetIndex !== "number") return 0
  return Math.abs(targetIndex - current)
}

function shouldPurgePrefetchQueues(jump) {
  const threshold = Number(constants.TELEPORT_QUEUE_PURGE_THRESHOLD) || 20
  return jump >= threshold
}

/**
 * Whether an authoritative (non-network) anchor commit is allowed and how
 * aggressively to reset prefetch tracking.
 */
function evaluateAuthorityCommit(tabState, targetIndex, authority) {
  const jump = anchorJump(tabState, targetIndex)
  const purgeQueues = shouldPurgePrefetchQueues(jump)

  if (authority === AnchorAuthority.DOM_SEEKED) {
    const minJump = Number(constants.DOM_TELEPORT_MIN_JUMP) || 10
    const cooldownMs = Number(constants.DOM_TELEPORT_COOLDOWN_MS) || 500
    const now = Date.now()

    if (Number.isFinite(jump) && jump < minJump) {
      return {
        allow: false,
        reason: "dom-seek-below-min-jump",
        jump,
        purgeQueues: false
      }
    }
    if (now - Number(tabState?.lastDomTeleportAt || 0) < cooldownMs) {
      return {
        allow: false,
        reason: "dom-seek-cooldown",
        jump,
        purgeQueues: false
      }
    }
    return { allow: true, reason: null, jump, purgeQueues }
  }

  if (authority === AnchorAuthority.SEEK_PREDICTION) {
    return { allow: true, reason: null, jump, purgeQueues }
  }

  return {
    allow: false,
    reason: "network-lane",
    jump,
    purgeQueues: false
  }
}

function authorityLabel(authority) {
  if (authority === AnchorAuthority.DOM_SEEKED) return "DOM_SEEKED"
  if (authority === AnchorAuthority.SEEK_PREDICTION) return "SEEK_PREDICTION"
  if (authority === AnchorAuthority.NETWORK) return "NETWORK"
  return "UNKNOWN"
}

ns.AnchorAuthority = AnchorAuthority
ns.evaluateAuthorityCommit = evaluateAuthorityCommit
ns.authorityLabel = authorityLabel
ns.shouldPurgePrefetchQueues = shouldPurgePrefetchQueues
})()
