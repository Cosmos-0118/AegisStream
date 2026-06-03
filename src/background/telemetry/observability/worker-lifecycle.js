(() => {
var ns = (self.AegisBackground ||= {})
const { state, addLog } = ns

const SESSION_COUNT_KEY = "workerStartCount"
const SESSION_STARTED_KEY = "workerLastStarted"
const SESSION_REASON_KEY = "workerLastReason"

let activationLogTimer = null

function setWorkerRestartReason(reason) {
  if (typeof reason !== "string" || !reason) return
  if (!state.workerLifecycle) {
    state.workerLifecycle = {
      startCount: 0,
      lastStartedAt: 0,
      lastReason: reason
    }
  } else {
    state.workerLifecycle.lastReason = reason
  }
  try {
    chrome.storage.session.set({ [SESSION_REASON_KEY]: reason })
  } catch {
    // ignore
  }
}

function flushWorkerActivationLog() {
  const lifecycle = state.workerLifecycle
  if (!lifecycle) return
  const count = Number(lifecycle.startCount) || 0
  const reason = lifecycle.lastReason || "activation"
  addLog("INFO", `SW started (#${count}, ${reason})`)
}

async function recordServiceWorkerActivation() {
  let count = 1
  let lastStartedAt = Date.now()
  let lastReason = "activation"
  try {
    const stored = await chrome.storage.session.get([
      SESSION_COUNT_KEY,
      SESSION_STARTED_KEY,
      SESSION_REASON_KEY
    ])
    count = Number(stored[SESSION_COUNT_KEY] || 0) + 1
    lastStartedAt = Date.now()
    lastReason = typeof stored[SESSION_REASON_KEY] === "string" ? stored[SESSION_REASON_KEY] : "activation"
    await chrome.storage.session.set({
      [SESSION_COUNT_KEY]: count,
      [SESSION_STARTED_KEY]: lastStartedAt,
      [SESSION_REASON_KEY]: lastReason
    })
  } catch (err) {
    addLog("WARN", `SW lifecycle persistence failed: ${err?.message || err}`)
  }

  state.workerLifecycle = {
    startCount: count,
    lastStartedAt,
    lastReason
  }

  clearTimeout(activationLogTimer)
  activationLogTimer = setTimeout(flushWorkerActivationLog, 50)
}

function getWorkerLifecycleSnapshot() {
  const lifecycle = state.workerLifecycle || {}
  return {
    workerStartCount: Number(lifecycle.startCount) || 0,
    workerLastStarted: Number(lifecycle.lastStartedAt) || 0,
    workerRestartReason: lifecycle.lastReason || null
  }
}

ns.setWorkerRestartReason = setWorkerRestartReason
ns.recordServiceWorkerActivation = recordServiceWorkerActivation
ns.getWorkerLifecycleSnapshot = getWorkerLifecycleSnapshot
})()
