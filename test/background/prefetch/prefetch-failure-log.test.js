/**
 * Run: node test/background/prefetch/prefetch-failure-log.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const constantsPath = path.join(__dirname, "../../../src/background/config/constants.js")
const logPath = path.join(__dirname, "../../../src/background/prefetch/prefetch-failure-log.js")

const sandbox = {
  self: {
    AegisBackground: {
      state: {
        playlistByTab: new Map([
          [
            1,
            {
              signatureToIndex: new Map([["sig-a", 27]]),
              segments: ["https://cdn.example.com/a.ts"]
            }
          ]
        ])
      },
      stripHash: (url) => url.split("#")[0],
      resolveSegmentIndexInManifest: (url, tabState) => {
        if (url.includes("a.ts")) return 27
        return null
      }
    }
  }
}
sandbox.globalThis = sandbox
vm.runInContext(fs.readFileSync(constantsPath, "utf8"), vm.createContext(sandbox))
vm.runInContext(fs.readFileSync(logPath, "utf8"), vm.createContext(sandbox))

const { formatPrefetchFailureLogLine } = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const line = formatPrefetchFailureLogLine(
  1,
  {
    url: "https://cdn.example.com/a.ts",
    fetchMode: "page",
    fetchPath: "originalFetch",
    status: 403,
    errorName: "HttpError",
    errorMessage: "Forbidden"
  },
  { attempts: 1, retryAfter: Date.now() + 2500 }
)

assert(line.includes("segment=27"), line)
assert(line.includes("status=403"), line)
assert(line.includes("mode=page"), line)
assert(line.includes("path=originalFetch"), line)
assert(line.includes("msg=Forbidden"), line)

console.log("prefetch-failure-log.test.js: OK")
