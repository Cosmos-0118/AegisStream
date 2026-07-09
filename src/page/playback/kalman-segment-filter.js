(() => {
  var ns = (self.AegisPageBridge ||= {})

  /** 1D Kalman filter in segment-index space (position + velocity). */
  class KalmanSegmentFilter {
    constructor() {
      this.x = [0, 0]
      this.P = [
        [1, 0],
        [0, 1]
      ]
      this.Q = [
        [0.15, 0],
        [0, 0.25]
      ]
      this.R = 0.8
      this.lastTime = null
      this.initialized = false
    }

    reset(measuredIndex = 0) {
      const index = Number(measuredIndex)
      this.x = [Number.isFinite(index) ? index : 0, 0]
      this.P = [
        [1, 0],
        [0, 1]
      ]
      this.lastTime = null
      this.initialized = false
    }

    update(measuredIndex, timestampMs) {
      const z = Number(measuredIndex)
      if (!Number.isFinite(z)) return this.x

      if (!this.initialized) {
        this.x[0] = z
        this.x[1] = 0
        this.lastTime = timestampMs
        this.initialized = true
        return this.x
      }

      const dt = (Number(timestampMs) - Number(this.lastTime)) / 1000
      if (!Number.isFinite(dt) || dt <= 0) return this.x

      this.x[0] = this.x[0] + this.x[1] * dt

      this.P[0][0] +=
        dt * (this.P[1][0] + this.P[0][1] + dt * this.P[1][1]) + this.Q[0][0]
      this.P[0][1] += dt * this.P[1][1] + this.Q[0][1]
      this.P[1][0] += dt * this.P[1][1] + this.Q[1][0]
      this.P[1][1] += this.Q[1][1]

      const innovation = z - this.x[0]
      const S = this.P[0][0] + this.R
      if (S <= 0) {
        this.lastTime = timestampMs
        return this.x
      }

      const Kpos = this.P[0][0] / S
      const Kvel = this.P[1][0] / S

      this.x[0] += Kpos * innovation
      this.x[1] += Kvel * innovation

      const p00 = this.P[0][0]
      const p01 = this.P[0][1]
      this.P[0][0] -= Kpos * p00
      this.P[0][1] -= Kpos * p01
      this.P[1][0] -= Kvel * p00
      this.P[1][1] -= Kvel * p01

      this.lastTime = timestampMs
      return this.x
    }

  }

  function resolveDynamicLookaheadSec(velocitySegPerSec) {
    const minSec =
      (Number(ns.SCRUB_KALMAN_LOOKAHEAD_MIN_MS) ||
        Number(globalThis.AegisPageBridge?.constants?.SCRUB_KALMAN_LOOKAHEAD_MIN_MS) ||
        200) / 1000
    const maxSec =
      (Number(ns.SCRUB_KALMAN_LOOKAHEAD_MAX_MS) ||
        Number(globalThis.AegisPageBridge?.constants?.SCRUB_KALMAN_LOOKAHEAD_MAX_MS) ||
        800) / 1000
    const baseSec =
      (Number(ns.SCRUB_KALMAN_LOOKAHEAD_BASE_MS) ||
        Number(globalThis.AegisPageBridge?.constants?.SCRUB_KALMAN_LOOKAHEAD_BASE_MS) ||
        200) / 1000
    const velScale =
      (Number(ns.SCRUB_KALMAN_LOOKAHEAD_VELOCITY_MS) ||
        Number(globalThis.AegisPageBridge?.constants?.SCRUB_KALMAN_LOOKAHEAD_VELOCITY_MS) ||
        80) / 1000
    const speed = Math.abs(Number(velocitySegPerSec) || 0)
    const horizon = baseSec + speed * velScale
    return Math.min(maxSec, Math.max(minSec, horizon))
  }

  KalmanSegmentFilter.prototype.predictIndex = function predictIndex(
    lookaheadSec,
    segmentCount,
    anchorIndex = null
  ) {
    const velocity = Number(this.x[1])
    const dynamicLookahead =
      Number.isFinite(lookaheadSec) && lookaheadSec > 0
        ? lookaheadSec
        : resolveDynamicLookaheadSec(velocity)

    const count = Number(segmentCount)
    const maxIndex = Number.isFinite(count) && count > 0 ? count - 1 : null
    let predicted = this.x[0] + velocity * dynamicLookahead
    const anchor = Number(anchorIndex)
    const maxJump = Number(ns.SCRUB_KALMAN_MAX_JUMP_SEGMENTS) || 8

    if (Number.isFinite(anchor)) {
      const delta = predicted - anchor
      if (Math.abs(delta) > maxJump) {
        predicted = anchor + Math.sign(delta) * maxJump
      }
    }

    if (maxIndex != null) {
      predicted = Math.max(0, Math.min(maxIndex, predicted))
    } else {
      predicted = Math.max(0, predicted)
    }

    return Math.round(predicted)
  }

  ns.resolveDynamicLookaheadSec = resolveDynamicLookaheadSec
  ns.KalmanSegmentFilter = KalmanSegmentFilter
})()
