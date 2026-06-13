(() => {
var ns = (self.AegisBackground ||= {})

function arrayBufferToBase64(buffer) {
  if (!buffer || typeof buffer.byteLength !== "number") return null
  const bytes = new Uint8Array(buffer)
  const chunkSize = 4096
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = Array.from(bytes.subarray(i, i + chunkSize))
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64) {
  if (typeof base64 !== "string" || base64.length === 0) return null
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function safeCopyArrayBuffer(bytes) {
  if (!bytes || typeof bytes.byteLength !== "number" || bytes.byteLength <= 0) {
    return null
  }
  try {
    const view =
      bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return view.slice().buffer
  } catch {
    return null
  }
}

const MAX_WIRE_BYTES = 32 * 1024 * 1024
/** Fingerprint window — full payload when smaller; avoids hashing multi-MiB segments. */
const CRC32_FINGERPRINT_BYTES = 64 * 1024

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function fingerprintByteView(bytes) {
  if (!bytes || typeof bytes.byteLength !== "number" || bytes.byteLength <= 0) {
    return null
  }
  const view =
    bytes instanceof ArrayBuffer
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength <= CRC32_FINGERPRINT_BYTES) return view
  return view.subarray(0, CRC32_FINGERPRINT_BYTES)
}

function crc32Fingerprint(bytes) {
  const view = fingerprintByteView(bytes)
  if (!view?.byteLength) return null
  let crc = 0xffffffff
  for (let i = 0; i < view.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ view[i]) & 0xff] ^ (crc >>> 8)
  }
  const hex = ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, "0")
  const byteLength =
    bytes instanceof ArrayBuffer
      ? bytes.byteLength
      : typeof bytes.byteLength === "number"
        ? bytes.byteLength
        : view.byteLength
  return {
    crc: hex,
    byteLength,
    sampleBytes: Math.min(byteLength, CRC32_FINGERPRINT_BYTES)
  }
}

function formatCrcTelemetry(bytes) {
  const fp = crc32Fingerprint(bytes)
  if (!fp) return ""
  if (fp.sampleBytes < fp.byteLength) {
    return `crc=${fp.crc}, crcSample=${fp.sampleBytes}`
  }
  return `crc=${fp.crc}`
}

function describeWireBytes(raw) {
  if (raw == null) return "none"
  if (raw instanceof ArrayBuffer) return "ArrayBuffer"
  if (ArrayBuffer.isView(raw)) {
    return raw.constructor?.name || "TypedArray"
  }
  if (typeof raw.byteLength === "number" && raw.buffer instanceof ArrayBuffer) {
    return "byteLength-view"
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return "plain-object"
  }
  return Object.prototype.toString.call(raw)
}

function describeStoreMessageWire(message) {
  if (typeof message?.bytesBase64 === "string" && message.bytesBase64.length > 0) {
    return "ipc-base64"
  }
  const wire = describeWireBytes(message?.bytes)
  if (wire === "ArrayBuffer" || wire === "TypedArray" || wire === "byteLength-view") {
    return "ipc-binary"
  }
  return wire
}

function coercePlainWireBytes(raw) {
  if (!raw || typeof raw !== "object" || ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer) {
    return null
  }
  if (typeof raw.byteLength === "number" && raw.byteLength > 0 && raw.byteLength <= MAX_WIRE_BYTES) {
    if (raw.buffer instanceof ArrayBuffer) {
      return safeCopyArrayBuffer(raw)
    }
    const length = Math.floor(raw.byteLength)
    const out = new Uint8Array(length)
    for (let i = 0; i < length; i += 1) {
      const value = raw[i]
      if (typeof value !== "number" || value < 0 || value > 255) return null
      out[i] = value
    }
    return out.buffer
  }
  if (Array.isArray(raw.data) && raw.data.length > 0 && raw.data.length <= MAX_WIRE_BYTES) {
    try {
      return new Uint8Array(raw.data).buffer
    } catch {
      return null
    }
  }
  return null
}

function extractMessageBytes(message) {
  const raw = message?.bytes
  if (raw != null) {
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
      return safeCopyArrayBuffer(raw)
    }
    if (typeof raw.byteLength === "number" && raw.byteLength > 0 && raw.buffer instanceof ArrayBuffer) {
      return safeCopyArrayBuffer(raw)
    }
    const coerced = coercePlainWireBytes(raw)
    if (coerced) return coerced
  }
  if (typeof message?.bytesBase64 === "string") {
    try {
      const decoded = base64ToArrayBuffer(message.bytesBase64)
      if (decoded && decoded.byteLength > MAX_WIRE_BYTES) return null
      return decoded
    } catch {
      return null
    }
  }
  return null
}

ns.arrayBufferToBase64 = arrayBufferToBase64
ns.base64ToArrayBuffer = base64ToArrayBuffer
ns.describeWireBytes = describeWireBytes
ns.describeStoreMessageWire = describeStoreMessageWire
ns.extractMessageBytes = extractMessageBytes
ns.crc32Fingerprint = crc32Fingerprint
ns.formatCrcTelemetry = formatCrcTelemetry
})()
