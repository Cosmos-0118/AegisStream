(() => {
var ns = (self.AegisPageBridge ||= {})
if (typeof ns.claimExecutionSlot === "function" && !ns.claimExecutionSlot("extension-fetch-client")) {
  return
}

const { nextRequestId, base64ToArrayBuffer } = ns

const EXTENSION_FETCH_TIMEOUT_MS = 15_000
const EXTENSION_STREAM_IDLE_TTL_MS = 10_000
const streamingByRequestId = new Map()

function postFetchRequest(payload) {
  const requestId = nextRequestId()
  window.postMessage(
    {
      __aegisstream: true,
      type: "EXTENSION_FETCH_REQUEST",
      requestId,
      ...payload,
      source: payload?.source || "prefetch-buffered"
    },
    "*"
  )
  return requestId
}

function assembleChunks(chunks, totalLength) {
  const out = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out.buffer
}

function getOrCreateStreamState(requestId) {
  let state = streamingByRequestId.get(requestId)
  if (state) return state
  state = {
    chunks: [],
    totalLength: 0,
    meta: null,
    settled: false,
    streamController: null,
    streamReady: null,
    resolveBuffered: null,
    rejectBuffered: null,
    createdAt: Date.now()
  }
  streamingByRequestId.set(requestId, state)
  return state
}

function settleStreamError(requestId, error) {
  const state = streamingByRequestId.get(requestId)
  if (!state || state.settled) return
  state.settled = true
  streamingByRequestId.delete(requestId)
  // Settle the streamReady (meta) promise so fetch interceptor never hangs
  if (state.streamReady) {
    state.streamReady({ ok: false, error: error || "extension fetch failed" })
  }
  if (state.streamController) {
    try {
      state.streamController.error(new Error(error || "extension fetch failed"))
    } catch {
      // Already closed or errored
    }
  }
  if (state.rejectBuffered) {
    state.rejectBuffered(new Error(error || "extension fetch failed"))
  }
  if (state.resolveBuffered) {
    state.resolveBuffered({ ok: false, error: error || "extension fetch failed" })
  }
}

function onExtensionFetchStreamMeta(requestId, response) {
  const state = getOrCreateStreamState(requestId)
  state.meta = response
  if (state.streamReady) {
    state.streamReady(response)
  }
}

function onExtensionFetchChunk(requestId, chunkBase64) {
  const state = streamingByRequestId.get(requestId)
  if (!state || state.settled) return

  const buffer = base64ToArrayBuffer(chunkBase64)
  if (!buffer || buffer.byteLength === 0) return

  const bytes = new Uint8Array(buffer)
  state.chunks.push(bytes)
  state.totalLength += bytes.byteLength

  if (state.streamController) {
    state.streamController.enqueue(bytes)
  }
}

function onExtensionFetchEnd(requestId, payload) {
  const state = streamingByRequestId.get(requestId)
  if (!state || state.settled) return
  state.settled = true
  streamingByRequestId.delete(requestId)

  if (!payload?.ok) {
    const error = payload?.error || "extension fetch failed"
    if (state.streamController) {
      try {
        state.streamController.error(new Error(error))
      } catch {
        // ignore
      }
    }
    if (state.resolveBuffered) {
      state.resolveBuffered({ ok: false, error })
    }
    return
  }

  if (state.streamController) {
    try {
      state.streamController.close()
    } catch {
      // ignore
    }
  }

  if (state.resolveBuffered) {
    const meta = state.meta || {}
    const bytes =
      state.totalLength > 0 ? assembleChunks(state.chunks, state.totalLength) : new ArrayBuffer(0)
    state.resolveBuffered({
      ok: true,
      statusCode: meta.statusCode,
      headers: meta.headers || {},
      bytes
    })
  }
}

function armFetchTimeout(requestId) {
  setTimeout(() => {
    const state = streamingByRequestId.get(requestId)
    if (!state || state.settled) return
    settleStreamError(requestId, "timeout")
  }, EXTENSION_FETCH_TIMEOUT_MS)
}

/**
 * Buffered extension fetch (prefetch / range-buffer). Uses chunked transport, single assembly in page.
 */
function requestExtensionFetchBuffered(payload) {
  return new Promise((resolve) => {
    const requestId = postFetchRequest(payload)
    const state = getOrCreateStreamState(requestId)
    state.resolveBuffered = resolve
    armFetchTimeout(requestId)
  })
}

/**
 * Streaming extension fetch for player intercept — returns a ReadableStream plus response metadata.
 */
function requestExtensionFetchStream(payload) {
  const requestId = nextRequestId()
  const state = getOrCreateStreamState(requestId)

  const stream = new ReadableStream({
    start(controller) {
      state.streamController = controller
    },
    cancel() {
      settleStreamError(requestId, "aborted")
      window.postMessage(
        {
          __aegisstream: true,
          type: "EXTENSION_FETCH_ABORT",
          requestId
        },
        "*"
      )
    }
  })

  window.postMessage(
    {
      __aegisstream: true,
      type: "EXTENSION_FETCH_REQUEST",
      requestId,
      ...payload,
      source: payload?.source || "player-stream"
    },
    "*"
  )

  const metaPromise = new Promise((resolve, reject) => {
    state.streamReady = (meta) => {
      if (!meta?.ok) {
        reject(new Error(meta?.error || "extension fetch failed"))
        return
      }
      resolve({
        statusCode: meta.statusCode,
        headers: meta.headers || {}
      })
    }
    state.rejectBuffered = reject
  })

  armFetchTimeout(requestId)

  return {
    requestId,
    stream,
    meta: metaPromise
  }
}

function isExtensionFetchInFlight(requestId) {
  return streamingByRequestId.has(requestId)
}

// Periodically sweep orphaned streams that never received any data
function sweepOrphanedStreams() {
  const now = Date.now()
  for (const [requestId, state] of streamingByRequestId.entries()) {
    if (state.settled) {
      streamingByRequestId.delete(requestId)
      continue
    }
    const createdAt = Number(state.createdAt || 0)
    if (createdAt > 0 && now - createdAt > EXTENSION_STREAM_IDLE_TTL_MS && state.totalLength === 0) {
      settleStreamError(requestId, "orphaned-stream-timeout")
    }
  }
}
setInterval(sweepOrphanedStreams, 5000)

const legacyRequestRuntime = ns.requestRuntime
if (typeof legacyRequestRuntime === "function") {
  ns.requestRuntime = function requestRuntime(type, payload) {
    if (type === "EXTENSION_FETCH_REQUEST") {
      return requestExtensionFetchBuffered(payload)
    }
    return legacyRequestRuntime(type, payload)
  }
}

ns.isExtensionFetchInFlight = isExtensionFetchInFlight
ns.onExtensionFetchStreamMeta = onExtensionFetchStreamMeta
ns.onExtensionFetchChunk = onExtensionFetchChunk
ns.onExtensionFetchEnd = onExtensionFetchEnd
ns.requestExtensionFetchBuffered = requestExtensionFetchBuffered
ns.requestExtensionFetchStream = requestExtensionFetchStream
})()
