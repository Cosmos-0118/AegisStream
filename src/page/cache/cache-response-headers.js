(() => {
  if (globalThis.AegisCacheResponseHeaders) return

  function applyInstantSwitchCacheHeaders(headers, options = {}) {
    if (!(headers instanceof Headers)) return headers
    headers.set("age", "0")
    headers.set("x-cache", "HIT")
    headers.set("x-aegisstream-cache", "HIT")
    if (options.instantSwitch !== false) {
      headers.set("x-aegisstream-instant", "1")
    }
    return headers
  }

  function buildInstantCacheHeaderRecord(contentType, options = {}) {
    const record = {
      "content-type": contentType || "application/octet-stream",
      "x-aegisstream-cache": "HIT",
      age: "0",
      "x-cache": "HIT",
      "x-aegisstream-instant": options.instantSwitch === false ? "0" : "1"
    }
    return record
  }

  globalThis.AegisCacheResponseHeaders = {
    applyInstantSwitchCacheHeaders,
    buildInstantCacheHeaderRecord
  }
})()
