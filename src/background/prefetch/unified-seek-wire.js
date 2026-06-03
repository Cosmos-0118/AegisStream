(() => {
  var ns = (self.AegisBackground ||= {})

  const FLAG_SCRUB = 1
  const FLAG_RELEASE = 2
  const FLAG_TRAIN_END = 4

  function parseUnifiedSeekWire(wire) {
    if (typeof wire !== "string" || !wire.length) return null
    const parts = wire.split("|")
    if (parts.length < 7) return null

    const timeSec = Number(parts[0])
    const estimatedIndex = Number(parts[1])
    const velocitySegPerSec = Number(parts[2])
    const velocityPredictedIndex = Number(parts[3])
    const currentIndex = Number(parts[4])
    const flags = Number(parts[5]) || 0
    const timestamp = Number(parts[6])

    if (!Number.isFinite(timeSec)) return null

    return {
      timeSec,
      estimatedIndex: Number.isFinite(estimatedIndex) && estimatedIndex >= 0 ? estimatedIndex : null,
      velocitySegPerSec: Number.isFinite(velocitySegPerSec) ? velocitySegPerSec : null,
      velocityPredictedIndex:
        Number.isFinite(velocityPredictedIndex) && velocityPredictedIndex >= 0
          ? velocityPredictedIndex
          : null,
      currentIndex: Number.isFinite(currentIndex) && currentIndex >= 0 ? currentIndex : null,
      isScrubbing: (flags & FLAG_SCRUB) !== 0,
      isRelease: (flags & FLAG_RELEASE) !== 0,
      scrubTrainEnded: (flags & FLAG_TRAIN_END) !== 0,
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now()
    }
  }

  function normalizeUnifiedSeekPayload(input) {
    if (input == null) return null
    if (typeof input === "string") return parseUnifiedSeekWire(input)
    if (typeof input.wire === "string") return parseUnifiedSeekWire(input.wire)
    if (typeof input.timeSec === "number") return input
    return null
  }

  ns.parseUnifiedSeekWire = parseUnifiedSeekWire
  ns.normalizeUnifiedSeekPayload = normalizeUnifiedSeekPayload
})()
