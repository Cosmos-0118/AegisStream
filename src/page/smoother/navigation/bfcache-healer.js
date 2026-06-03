/**
 * BFcache freeze-thaw healer: unload → pagehide migration, socket parking, auto re-hydration.
 * MAIN world; must run at document_start before host scripts (registered by background).
 */
;(() => {
  "use strict"
  var ns = self.AegisPageBridge || (self.AegisPageBridge = {})
  const smoother = ns.smoother

  function installBfcacheHealer() {
    if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("bfcache-healer")) {
      return
    }
    if (smoother?.isSmootherSkippedHost?.(location.hostname)) return

    const socketRegistry = new Set()
    const eventSourceRegistry = new Set()

    function migrateUnloadListeners() {
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

    migrateUnloadListeners()

    function migrateWindowUnloadProperties() {
      function upgradeProperty(eventName) {
        const prop = `on${eventName}`
        let internalHandler = null

        Object.defineProperty(window, prop, {
          get() {
            return internalHandler
          },
          set(newHandler) {
            if (internalHandler) {
              window.removeEventListener("pagehide", internalHandler)
            }
            if (typeof newHandler === "function") {
              internalHandler = newHandler
              window.addEventListener("pagehide", internalHandler)
            } else {
              internalHandler = null
            }
          },
          configurable: true,
          enumerable: true
        })
      }

      upgradeProperty("unload")
      upgradeProperty("beforeunload")
    }

    migrateWindowUnloadProperties()

    function defineUnderlyingAccessor(facade, meta, prop) {
      Object.defineProperty(facade, prop, {
        enumerable: true,
        configurable: true,
        get() {
          const value = meta.underlying?.[prop]
          return typeof value === "function" ? value.bind(meta.underlying) : value
        }
      })
    }

    function defineHandlerProperty(facade, meta, name) {
      Object.defineProperty(facade, `on${name}`, {
        enumerable: true,
        configurable: true,
        get() {
          return meta.propertyHandlers[name] ?? null
        },
        set(fn) {
          meta.propertyHandlers[name] = typeof fn === "function" ? fn : null
          if (meta.underlying) {
            meta.underlying[`on${name}`] = meta.propertyHandlers[name]
          }
        }
      })
    }

    function bindUnderlying(meta, socket) {
      meta.underlying = socket
      for (const entry of meta.listenerEntries) {
        socket.addEventListener(entry.type, entry.listener, entry.options)
      }
      for (const [name, fn] of Object.entries(meta.propertyHandlers)) {
        if (fn) socket[`on${name}`] = fn
      }
    }

    function parkSocket(meta, OriginalWebSocket) {
      const socket = meta.underlying
      if (!socket) return
      const state = socket.readyState
      if (state === OriginalWebSocket.OPEN || state === OriginalWebSocket.CONNECTING) {
        meta.frozen = true
        try {
          socket.close(1000, "aegis-bfcache-freeze")
        } catch {
          // ignore
        }
      }
    }

    function thawSocket(meta, OriginalWebSocket) {
      if (!meta.frozen) return
      meta.frozen = false
      const socket =
        meta.protocols === undefined
          ? new OriginalWebSocket(meta.url)
          : new OriginalWebSocket(meta.url, meta.protocols)
      // Re-bound open/message listeners run again on the fresh socket; handshake logic
      // wired through onopen or addEventListener("open") is replayed automatically.
      bindUnderlying(meta, socket)
    }

    function wrapWebSocket(OriginalWebSocket) {
      if (typeof OriginalWebSocket !== "function") return

      function HealingWebSocket(url, protocols) {
        const meta = {
          url,
          protocols,
          underlying: null,
          frozen: false,
          listenerEntries: [],
          propertyHandlers: {}
        }

        const facade = Object.create(OriginalWebSocket.prototype)

        facade.addEventListener = function (type, listener, options) {
          meta.listenerEntries.push({ type, listener, options })
          meta.underlying?.addEventListener(type, listener, options)
        }

        facade.removeEventListener = function (type, listener, options) {
          meta.listenerEntries = meta.listenerEntries.filter(
            (entry) => entry.type !== type || entry.listener !== listener
          )
          meta.underlying?.removeEventListener(type, listener, options)
        }

        facade.dispatchEvent = function (event) {
          return meta.underlying?.dispatchEvent(event) ?? false
        }

        facade.send = function (data) {
          return meta.underlying?.send(data)
        }

        facade.close = function (code, reason) {
          return meta.underlying?.close(code, reason)
        }

        for (const prop of ["readyState", "bufferedAmount", "extensions", "protocol", "binaryType"]) {
          defineUnderlyingAccessor(facade, meta, prop)
        }

        Object.defineProperty(facade, "url", {
          enumerable: true,
          get() {
            return meta.underlying?.url ?? String(meta.url)
          }
        })

        for (const name of ["open", "message", "close", "error"]) {
          defineHandlerProperty(facade, meta, name)
        }

        const socket =
          protocols === undefined
            ? new OriginalWebSocket(url)
            : new OriginalWebSocket(url, protocols)
        bindUnderlying(meta, socket)
        socketRegistry.add(meta)

        return facade
      }

      HealingWebSocket.prototype = OriginalWebSocket.prototype
      Object.setPrototypeOf(HealingWebSocket, OriginalWebSocket)
      for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
        if (!(key in OriginalWebSocket)) continue
        try {
          Object.defineProperty(HealingWebSocket, key, {
            value: OriginalWebSocket[key],
            writable: true,
            configurable: true,
            enumerable: true
          })
        } catch {
          // Static properties may be read-only on some engines; prototype chain still works.
        }
      }

      window.WebSocket = HealingWebSocket
    }

    function wrapEventSource(OriginalEventSource) {
      if (typeof OriginalEventSource !== "function") return

      function HealingEventSource(url, options) {
        const meta = {
          url,
          options,
          underlying: null,
          frozen: false,
          listenerEntries: [],
          propertyHandlers: {}
        }

        const facade = Object.create(OriginalEventSource.prototype)

        facade.addEventListener = function (type, listener, options) {
          meta.listenerEntries.push({ type, listener, options })
          meta.underlying?.addEventListener(type, listener, options)
        }

        facade.removeEventListener = function (type, listener, options) {
          meta.listenerEntries = meta.listenerEntries.filter(
            (entry) => entry.type !== type || entry.listener !== listener
          )
          meta.underlying?.removeEventListener(type, listener, options)
        }

        facade.close = function () {
          return meta.underlying?.close()
        }

        for (const prop of ["readyState", "withCredentials"]) {
          defineUnderlyingAccessor(facade, meta, prop)
        }

        Object.defineProperty(facade, "url", {
          enumerable: true,
          get() {
            return meta.underlying?.url ?? String(meta.url)
          }
        })

        for (const name of ["open", "message", "error"]) {
          defineHandlerProperty(facade, meta, name)
        }

        const source = options ? new OriginalEventSource(url, options) : new OriginalEventSource(url)
        bindUnderlying(meta, source)
        eventSourceRegistry.add(meta)

        return facade
      }

      HealingEventSource.prototype = OriginalEventSource.prototype
      Object.setPrototypeOf(HealingEventSource, OriginalEventSource)

      window.EventSource = HealingEventSource
    }

    const OriginalWebSocket = window.WebSocket
    const OriginalEventSource = window.EventSource
    wrapWebSocket(OriginalWebSocket)
    wrapEventSource(OriginalEventSource)

    window.addEventListener(
      "pagehide",
      () => {
        for (const meta of socketRegistry) {
          parkSocket(meta, OriginalWebSocket)
        }
        for (const meta of eventSourceRegistry) {
          if (!meta.underlying) continue
          meta.frozen = true
          try {
            meta.underlying.close()
          } catch {
            // ignore
          }
        }
        if (typeof ns.logBridge === "function") {
          ns.logBridge("BFcache healer: parked live connections", "DEBUG")
        }
      },
      true
    )

    window.addEventListener(
      "pageshow",
      (event) => {
        if (!event.persisted) return
        for (const meta of socketRegistry) {
          thawSocket(meta, OriginalWebSocket)
        }
        for (const meta of eventSourceRegistry) {
          if (!meta.frozen) continue
          meta.frozen = false
          const source = meta.options
            ? new OriginalEventSource(meta.url, meta.options)
            : new OriginalEventSource(meta.url)
          bindUnderlying(meta, source)
        }
        if (typeof ns.logBridge === "function") {
          ns.logBridge("BFcache healer: re-hydrated connections after restore", "DEBUG")
        }
      },
      true
    )

    if (typeof ns.logBridge === "function") {
      ns.logBridge("BFcache healer active (freeze-thaw)", "DEBUG")
    }
  }

  ns.installBfcacheHealer = installBfcacheHealer
  ns.installBfcacheEnforcer = installBfcacheHealer
  installBfcacheHealer()
})()
