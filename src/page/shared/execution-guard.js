/**
 * Must load before other MAIN-world bundles. Prevents duplicate hooks when
 * executeScript reinjects the page bridge chain into an already-armed tab.
 */
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self
  const ns = (root.AegisPageBridge ||= {})

  ns.claimExecutionSlot = function claimExecutionSlot(slot) {
    if (!slot) return true
    const armed = ns.__executionArmed || (ns.__executionArmed = Object.create(null))
    if (armed[slot]) return false
    armed[slot] = true
    const flag = `__AEGIS_ARMED_${String(slot).replace(/[^a-z0-9]+/gi, "_").toUpperCase()}__`
    root[flag] = true
    return true
  }
})()
