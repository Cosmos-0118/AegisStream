(() => {
var ns = (self.AegisPageBridge ||= {})
const smoother = ns.smoother

function installBfcacheEnforcer() {
  if (ns.__bfcacheEnforcerInstalled === true) return
  if (smoother?.isSmootherSkippedHost?.(location.hostname)) return
  ns.__bfcacheEnforcerInstalled = true

  const webSockets = new Set()
  const eventSources = new Set()

  const OriginalWebSocket = window.WebSocket
  if (typeof OriginalWebSocket === "function") {
    window.WebSocket = function AegisWebSocket(...args) {
      const socket = new OriginalWebSocket(...args)
      webSockets.add(socket)
      socket.addEventListener("close", () => webSockets.delete(socket))
      socket.addEventListener("error", () => webSockets.delete(socket))
      return socket
    }
    window.WebSocket.prototype = OriginalWebSocket.prototype
    Object.setPrototypeOf(window.WebSocket, OriginalWebSocket)
  }

  const OriginalEventSource = window.EventSource
  if (typeof OriginalEventSource === "function") {
    window.EventSource = function AegisEventSource(...args) {
      const source = new OriginalEventSource(...args)
      eventSources.add(source)
      source.addEventListener("error", () => eventSources.delete(source))
      return source
    }
    window.EventSource.prototype = OriginalEventSource.prototype
    Object.setPrototypeOf(window.EventSource, OriginalEventSource)
  }

  function severDanglingConnections() {
    for (const socket of webSockets) {
      try {
        if (socket.readyState === OriginalWebSocket.OPEN || socket.readyState === OriginalWebSocket.CONNECTING) {
          socket.close(1000, "aegis-bfcache")
        }
      } catch {
        // ignore
      }
    }
    for (const source of eventSources) {
      try {
        source.close()
      } catch {
        // ignore
      }
    }
    webSockets.clear()
    eventSources.clear()
  }

  function neutralizeLegacyUnload() {
    try {
      window.onunload = null
      window.onbeforeunload = null
    } catch {
      // ignore
    }

    const originalAdd = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function patchedAdd(type, listener, options) {
      if (this === window && type === "unload") {
        return originalAdd.call(this, "pagehide", listener, options)
      }
      return originalAdd.call(this, type, listener, options)
    }

    const originalRemove = EventTarget.prototype.removeEventListener
    EventTarget.prototype.removeEventListener = function patchedRemove(type, listener, options) {
      if (this === window && type === "unload") {
        return originalRemove.call(this, "pagehide", listener, options)
      }
      return originalRemove.call(this, type, listener, options)
    }
  }

  neutralizeLegacyUnload()

  window.addEventListener(
    "pagehide",
    () => {
      severDanglingConnections()
      if (typeof ns.logBridge === "function") {
        ns.logBridge("BFcache enforcer: severed dangling connections", "DEBUG")
      }
    },
    true
  )

  window.addEventListener(
    "pageshow",
    (event) => {
      if (event.persisted && typeof ns.logBridge === "function") {
        ns.logBridge("BFcache restore detected (persisted)", "DEBUG")
      }
    },
    true
  )

  if (typeof ns.logBridge === "function") {
    ns.logBridge("BFcache enforcer active", "DEBUG")
  }
}

ns.installBfcacheEnforcer = installBfcacheEnforcer
})()
