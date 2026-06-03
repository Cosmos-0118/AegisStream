(() => {
  globalThis.claimAegisContentSlot = function claimAegisContentSlot(slot) {
    if (!slot) return true
    const armed = globalThis.__aegisContentArmed || (globalThis.__aegisContentArmed = Object.create(null))
    if (armed[slot]) return false
    armed[slot] = true
    globalThis[`__AEGIS_CONTENT_ARMED_${String(slot).replace(/[^a-z0-9]+/gi, "_").toUpperCase()}__`] =
      true
    return true
  }
})()
