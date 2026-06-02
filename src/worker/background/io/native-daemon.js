(() => {
var ns = (self.AegisBackground ||= {})
const { addLog, arrayBufferToBase64 } = ns

class NativeDaemonManager {
  constructor() {
    this.port = null
    this.pendingRequests = new Map()
    this.reqId = 0
  }

  connect() {
    if (this.port) return
    try {
      this.port = chrome.runtime.connectNative("com.aegisstream.daemon")
      this.port.onMessage.addListener(this.onMessage.bind(this))
      this.port.onDisconnect.addListener(() => {
        addLog("WARN", `Native daemon disconnected: ${chrome.runtime.lastError?.message}`)
        this.port = null
        for (const [id, req] of this.pendingRequests.entries()) {
          req.reject(new Error("Native daemon disconnected"))
          this.pendingRequests.delete(id)
        }
      })
      addLog("INFO", "Connected to Native Daemon")
    } catch (e) {
      addLog("ERROR", `Failed to connect to Native Daemon: ${e.message}`)
    }
  }

  onMessage(msg) {
    if (!msg || !msg.id) return
    const req = this.pendingRequests.get(msg.id)
    if (!req) return
    if (msg.type === "start") {
      req.responseInfo = { statusCode: msg.statusCode, headers: msg.headers, chunks: [] }
    } else if (msg.type === "chunk") {
      if (req.responseInfo) req.responseInfo.chunks.push(msg.data)
    } else if (msg.type === "end") {
      this.pendingRequests.delete(msg.id)
      req.resolve(req.responseInfo)
    } else if (msg.type === "error") {
      this.pendingRequests.delete(msg.id)
      req.reject(new Error(msg.error || "Daemon fetch failed"))
    }
  }

  async fetch(url, method = "GET", headers = {}, body = null) {
    if (!this.port) this.connect()
    if (!this.port) throw new Error("Native Daemon not available")
    return new Promise((resolve, reject) => {
      this.reqId += 1
      const id = `req-${this.reqId}`
      let base64Body = ""
      if (body instanceof ArrayBuffer) {
        base64Body = arrayBufferToBase64(body)
      } else if (typeof body === "string") {
        base64Body = btoa(body)
      } else if (body && typeof body.byteLength === "number") {
        base64Body = arrayBufferToBase64(body.buffer ? body.buffer : body)
      }
      this.pendingRequests.set(id, { resolve, reject, responseInfo: null })
      this.port.postMessage({ id, type: "fetch", url, method, headers, body: base64Body })
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error("Native daemon request timed out"))
        }
      }, 65000)
    })
  }
}

const daemonManager = new NativeDaemonManager()
daemonManager.connect()

ns.daemonManager = daemonManager
})()
