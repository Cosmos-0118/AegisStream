/**
 * Run: node src/worker/background/smoother/layout-asset-store.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const store = {}

const sandbox = {
  self: {},
  URL,
  chrome: {
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: store[key] }
          return { ...store }
        },
        async set(payload) {
          Object.assign(store, payload)
        }
      }
    }
  }
}

vm.runInContext(fs.readFileSync(path.join(__dirname, "layout-asset-store.js"), "utf8"), vm.createContext(sandbox))
const api = sandbox.self.AegisBackground

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function run() {
  await api.recordLayoutAssets("https://shop.example.com", "/product/abc", [
    { url: "https://shop.example.com/static/app.js", type: "script" },
    { url: "https://shop.example.com/static/app.css", type: "style" }
  ])

  const withQuery = await api.lookupAssetsForUrl(
    "https://shop.example.com/product/abc?th=1&ref=1"
  )
  assert(withQuery.assets.length === 2, "path match should ignore query string")
  assert(withQuery.matchedPath === "/product/abc", "should match exact path")

  const merged = await api.recordLayoutAssets("https://shop.example.com", "/product/abc", [
    { url: "https://shop.example.com/static/extra.js", type: "script" }
  ])
  assert(merged.length === 3, "should merge new assets into existing path record")

  await api.recordLayoutAssets("https://shop.example.com", "/", [
    { url: "https://shop.example.com/global.css", type: "style" }
  ])
  const fallback = await api.lookupAssetsForUrl("https://shop.example.com/unknown/page")
  assert(fallback.assets.length >= 1, "should fall back to origin root assets")
  assert(fallback.matchedPath === "/", "should use origin root path bucket")

  console.log("layout-asset-store tests passed")
}

void run()
