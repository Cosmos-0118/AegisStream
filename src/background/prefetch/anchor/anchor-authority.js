(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

const AnchorAuthority = {
  NETWORK: 1,
  SEEK_PREDICTION: 2,
  DOM_SEEKED: 3
}

function getEffectiveAnchorIndex(tabState) {
  if (!tabState) return null
  if (typeof tabState.anchorIndex === "number") return tabState.anchorIndex
  if (typeof tabState.teleportTargetIndex === "number") return tabState.teleportTargetIndex
  if (typeof tabState.predictedAnchorIndex === "number") return tabState.predictedAnchorIndex
  return null
}

function anchorJump(tabState, targetIndex) {
  const current = getEffectiveAnchorIndex(tabState)
  if (typeof current !== "number" || typeof targetIndex !== "number") return 0
  return Math.abs(targetIndex - current)
}

function shouldPurgePrefetchQueues(jump) {
  if (!Number.isFinite(jump) || jump <= 0) return false
  const threshold = Number(constants.TELEPORT_QUEUE_PURGE_THRESHOLD) || 20
  return jump >= threshold
}

/** During scrubbing train, only hard-purge when the anchor actually moves meaningfully. */
function shouldPurgeQueuesDuringScrub(jump) {
  if (!Number.isFinite(jump) || jump <= 0) return false
  const minJump = Number(constants.ANCHOR_TELEPORT_JUMP_THRESHOLD) || 5
  return jump >= minJump
}

function isScrubbingTrainActive(tabState, now = Date.now()) {
  if (!tabState) return false
  return now < Number(tabState.scrubbingTrainUntil || 0)
}

function isVariantSwitchGraceActive(tabState, now = Date.now()) {
  if (!tabState) return false
  return now < Number(tabState.variantSwitchGraceUntil || 0)
}

function shouldBlockDomAnchorDuringVariantGrace(tabState, targetIndex) {
  if (!isVariantSwitchGraceActive(tabState)) return false
  const retained = tabState.variantSwitchAnchorIndex
  if (typeof retained !== "number" || typeof targetIndex !== "number") return false
  if (targetIndex >= retained - 2) return false
  const earlyBound = Math.max(2, Math.floor(retained * 0.1))
  return targetIndex <= earlyBound
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
    const current = getEffectiveAnchorIndex(tabState)

    if (typeof current !== "number") {
      return { allow: true, reason: null, jump: 0, purgeQueues: false }
    }

    if (isScrubbingTrainActive(tabState, now)) {
      return {
        allow: true,
        reason: null,
        jump,
        // Every scrub step must hard-purge so in-flight prefetch slots stay near the playhead.
        purgeQueues: jump > 0
      }
    }

    if (shouldBlockDomAnchorDuringVariantGrace(tabState, targetIndex)) {
      return {
        allow: false,
        reason: "variant-switch-grace",
        jump,
        purgeQueues: false
      }
    }

    if (jump < minJump) {
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
ns.getEffectiveAnchorIndex = getEffectiveAnchorIndex
ns.anchorJump = anchorJump
ns.evaluateAuthorityCommit = evaluateAuthorityCommit
ns.authorityLabel = authorityLabel
ns.shouldPurgePrefetchQueues = shouldPurgePrefetchQueues
ns.shouldPurgeQueuesDuringScrub = shouldPurgeQueuesDuringScrub
ns.isScrubbingTrainActive = isScrubbingTrainActive
})()
