(() => {
var ns = (self.AegisBackground ||= {})

function arrayBufferToBase64(buffer) {
  if (!buffer || typeof buffer.byteLength !== "number") return null
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
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

function extractMessageBytes(message) {
  if (message?.bytes && typeof message.bytes.byteLength === "number") {
    return message.bytes
  }
  if (typeof message?.bytesBase64 === "string") {
    try {
      return base64ToArrayBuffer(message.bytesBase64)
    } catch {
      return null
    }
  }
  return null
}

ns.arrayBufferToBase64 = arrayBufferToBase64
ns.base64ToArrayBuffer = base64ToArrayBuffer
ns.extractMessageBytes = extractMessageBytes
})()
