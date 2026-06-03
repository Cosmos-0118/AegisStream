(() => {
var ns = (self.AegisBackground ||= {})

const FETCH_TIMEOUT_MS = 65_000
const STREAM_CHUNK_SIZE = 256 * 1024

function fetchWithTimeout(url, init, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer)
  })
}

function sanitizeRequestHeaders(headers) {
  const out = new Headers()
  if (!headers || typeof headers !== "object") return out
  for (const [key, value] of Object.entries(headers)) {
    if (!key || value == null) continue
    const lower = String(key).toLowerCase()
    if (lower.startsWith("x-aegis")) continue
    out.set(key, String(value))
  }
  return out
}

function headersToObject(headers) {
  const out = {}
  if (!headers || typeof headers.forEach !== "function") return out
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

async function raceExtensionFetch(url, init = {}) {
  const controllerA = new AbortController()
  const controllerB = new AbortController()
  const sharedInit = {
    ...init,
    cache: "no-store",
    redirect: "follow"
  }

  const runPath = (credentials, priority, controller) =>
    fetch(url, {
      ...sharedInit,
      credentials,
      priority,
      signal: controller.signal
    }).then((response) => ({ response, controller }))

  const pathA = runPath("include", "high", controllerA)
  const pathB = runPath("omit", "low", controllerB)
  pathA.catch(() => {})
  pathB.catch(() => {})

  try {
    const winner = await Promise.race([pathA, pathB])
    const loser = winner.controller === controllerA ? controllerB : controllerA
    loser.abort()

    if (!winner.response.ok) {
      throw new Error(`HTTP ${winner.response.status}`)
    }
    return winner.response
  } catch {
    controllerA.abort()
    controllerB.abort()
    return fetchWithTimeout(url, {
      ...sharedInit,
      credentials: "include"
    })
  }
}

async function fetchExtensionResponse(url, method = "GET", headers = {}, body = null, options = {}) {
  const tabId = options.tabId
  const methodUpper = String(method || "GET").toUpperCase()
  let fetchUrl = url
  if (typeof ns.applyTwitchSessionToUrl === "function" && Number.isFinite(tabId)) {
    fetchUrl = ns.applyTwitchSessionToUrl(tabId, fetchUrl)
  }
  const requestHeaders =
    typeof ns.mergeTwitchRequestHeaders === "function"
      ? ns.mergeTwitchRequestHeaders(fetchUrl, sanitizeRequestHeaders(headers), tabId)
      : sanitizeRequestHeaders(headers)
  const init = {
    method: methodUpper,
    headers: requestHeaders
  }
  if (options.signal) {
    init.signal = options.signal
  }

  if (body && methodUpper !== "GET" && methodUpper !== "HEAD") {
    init.body = body
  }

  const fetchOnce = async (targetUrl) => {
    if (methodUpper === "GET" || methodUpper === "HEAD") {
      return raceExtensionFetch(targetUrl, init)
    }
    return fetchWithTimeout(targetUrl, {
      ...init,
      credentials: "include",
      cache: "no-store",
      redirect: "follow"
    })
  }

  let response = await fetchOnce(fetchUrl)
  if (
    !response.ok &&
    (response.status === 401 || response.status === 403) &&
    Number.isFinite(tabId) &&
    typeof ns.applyTwitchSessionToUrl === "function" &&
    typeof ns.isTwitchMediaUrl === "function" &&
    ns.isTwitchMediaUrl(url)
  ) {
    const retryUrl = ns.applyTwitchSessionToUrl(tabId, url)
    if (retryUrl !== fetchUrl) {
      response = await fetchOnce(retryUrl)
    }
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  return response
}

/**
 * Read response.body in fixed-size chunks and invoke onChunk(index, uint8Array).
 * Does not buffer the full body in memory.
 */
async function pumpResponseBody(response, onChunk) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > 0) {
      await onChunk(0, bytes)
    }
    return 1
  }

  const reader = response.body.getReader()
  let pending = new Uint8Array(0)
  let chunkIndex = 0

  const flushFullChunks = async () => {
    while (pending.length >= STREAM_CHUNK_SIZE) {
      const slice = pending.subarray(0, STREAM_CHUNK_SIZE)
      await onChunk(chunkIndex, slice)
      chunkIndex += 1
      pending = pending.subarray(STREAM_CHUNK_SIZE)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (value && value.length > 0) {
      const merged = new Uint8Array(pending.length + value.length)
      merged.set(pending)
      merged.set(value, pending.length)
      pending = merged
      await flushFullChunks()
    }
    if (done) {
      await flushFullChunks()
      if (pending.length > 0) {
        await onChunk(chunkIndex, pending)
        chunkIndex += 1
      }
      break
    }
  }

  return chunkIndex
}

ns.FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS
ns.STREAM_CHUNK_SIZE = STREAM_CHUNK_SIZE
ns.fetchExtensionResponse = fetchExtensionResponse
ns.pumpResponseBody = pumpResponseBody
ns.raceExtensionFetch = raceExtensionFetch
ns.headersToObject = headersToObject
ns.sanitizeRequestHeaders = sanitizeRequestHeaders
})()
