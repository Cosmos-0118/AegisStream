(() => {
var ns = (self.AegisBackground ||= {})

function isSkippableDocumentUrl(url) {
  if (typeof url !== "string") return true
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true
    const host = parsed.hostname || ""
    return host === "youtube.com" || host.endsWith(".youtube.com")
  } catch {
    return true
  }
}

function createHeadStreamPatcher(pageUrl) {
  const scanner = ns.createStreamingHeadScanner(pageUrl)
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const encoder = new TextEncoder()
  let passthroughBytes = false
  let pendingText = ""

  function encodeAndReturn(text) {
    const out = encoder.encode(text)
    pendingText = ""
    return out
  }

  return {
    processChunk(arrayBuffer) {
      if (passthroughBytes) return { passthrough: arrayBuffer }

      if (scanner.isFinalized()) {
        const text = decoder.decode(arrayBuffer, { stream: true })
        if (!text) return { pending: true }
        return { output: encodeAndReturn(text) }
      }

      try {
        const text = decoder.decode(arrayBuffer, { stream: true })
        pendingText += text

        const result = scanner.appendText(pendingText)
        pendingText = ""

        if (result.status === "pending") {
          return { pending: true }
        }

        if (result.status === "passthrough") {
          passthroughBytes = true
          scanner.enterPassthrough()
          const html = result.html || ""
          return html ? { output: encodeAndReturn(html) } : { pending: true }
        }

        if (result.status === "finalized") {
          return {
            output: encodeAndReturn(result.html || ""),
            injectedCount: result.injectedCount || 0,
            reason: result.reason
          }
        }

        return { pending: true }
      } catch {
        scanner.enterPassthrough()
        passthroughBytes = true
        try {
          const fallback = pendingText + decoder.decode(arrayBuffer, { stream: true })
          pendingText = ""
          return fallback ? { output: encodeAndReturn(fallback), reason: "decode-error" } : { passthrough: arrayBuffer }
        } catch {
          return { passthrough: arrayBuffer }
        }
      }
    },
    flush() {
      if (passthroughBytes) return null
      try {
        const tailText = pendingText + decoder.decode()
        pendingText = ""
        if (!scanner.isFinalized() && tailText) {
          scanner.appendText(tailText)
        }
        const result = scanner.finalizeRemainder()
        const html = result.html || tailText
        if (!html) return null
        return encodeAndReturn(html)
      } catch {
        return null
      }
    }
  }
}

function attachHtmlStreamInjector(filter, pageUrl, onPatched) {
  const patcher = createHeadStreamPatcher(pageUrl)

  filter.ondata = (event) => {
    try {
      const result = patcher.processChunk(event.data)
      if (result.passthrough) {
        filter.write(event.data)
        return
      }
      if (result.pending) return
      if (result.output) {
        if (result.injectedCount > 0 && typeof onPatched === "function") {
          onPatched(result.injectedCount, pageUrl, result.reason)
        }
        filter.write(result.output)
      }
    } catch {
      try {
        filter.write(event.data)
      } catch {
        filter.disconnect()
      }
    }
  }

  filter.onstop = () => {
    try {
      const tail = patcher.flush()
      if (tail) filter.write(tail)
    } catch {
      // ignore
    }
    filter.disconnect()
  }

  filter.onerror = () => {
    try {
      filter.disconnect()
    } catch {
      // ignore
    }
  }
}

ns.isSkippableDocumentUrl = isSkippableDocumentUrl
ns.createHeadStreamPatcher = createHeadStreamPatcher
ns.attachHtmlStreamInjector = attachHtmlStreamInjector
})()
