/**
 * Run: node test/background/media/serializers.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const serializersPath = path.join(
  __dirname,
  "../../../src/background/media/serializers.js"
)

const sandbox = { self: {}, ArrayBuffer, Uint8Array, atob, btoa: (s) => Buffer.from(s, "binary").toString("base64") }
sandbox.self = sandbox
vm.runInContext(fs.readFileSync(serializersPath, "utf8"), vm.createContext(sandbox))

const { extractMessageBytes, describeWireBytes, describeStoreMessageWire, crc32Fingerprint } =
  sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const source = new Uint8Array([10, 20, 30]).buffer
const fromView = extractMessageBytes({ bytes: new Uint8Array(source) })
assert(fromView instanceof ArrayBuffer, "typed array payload should unwrap to ArrayBuffer")
assert(fromView.byteLength === 3, "unwrap should preserve length")

const fromBuffer = extractMessageBytes({ bytes: source })
assert(fromBuffer?.byteLength === 3, "ArrayBuffer payload should copy")

assert(describeWireBytes(new Uint8Array(4)) === "Uint8Array", "wire type for Uint8Array")
assert(describeWireBytes(source) === "ArrayBuffer", "wire type for ArrayBuffer")
assert(describeWireBytes(null) === "none", "wire type for missing bytes")
assert(
  describeStoreMessageWire({ bytesBase64: "AQID" }) === "ipc-base64",
  "store wire base64"
)

const b64 = Buffer.from([40, 41, 42]).toString("base64")
const fromB64 = extractMessageBytes({ bytesBase64: b64 })
assert(fromB64?.byteLength === 3, "base64 payload should decode")

const indexed = { byteLength: 2, 0: 9, 1: 8 }
const fromIndexed = extractMessageBytes({ bytes: indexed })
assert(fromIndexed?.byteLength === 2, "indexed plain object should coerce")
const indexedView = new Uint8Array(fromIndexed)
assert(indexedView[0] === 9 && indexedView[1] === 8, "indexed bytes preserved")

const known = new TextEncoder().encode("123456789")
const fp = crc32Fingerprint(known.buffer)
assert(fp?.crc === "CBF43926", "crc32 known vector")

console.log("serializers.test.js: all assertions passed")
