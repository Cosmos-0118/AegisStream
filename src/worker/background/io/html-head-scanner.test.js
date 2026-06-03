/**
 * Run: node src/worker/background/io/html-head-scanner.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const scannerPath = path.join(__dirname, "html-head-scanner.js")
const code = fs.readFileSync(scannerPath, "utf8")
const sandbox = { self: {}, URL }
vm.runInContext(code, vm.createContext(sandbox))
const api = sandbox.self.AegisBackground._htmlHeadScanner
const create = sandbox.self.AegisBackground.createStreamingHeadScanner

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function countSubstring(haystack, needle) {
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystack.indexOf(needle, pos)
    if (idx < 0) break
    count += 1
    pos = idx + needle.length
  }
  return count
}

function feedChunks(scanner, chunks) {
  let html = ""
  let injected = 0
  let reason = ""
  for (const chunk of chunks) {
    const result = scanner.appendText(chunk)
    if (result.status === "finalized") {
      html = result.html
      injected = result.injectedCount
      reason = result.reason
      break
    }
  }
  if (!html) {
    const tail = scanner.finalizeRemainder()
    html = tail.html
    injected = tail.injectedCount
    reason = tail.reason
  }
  return { html, injected, reason }
}

function testSplitScriptTag() {
  const chunks = [
    "<html><head><scr",
    'ipt src="/app.js"></scr',
    'ipt><link rel="stylesheet" href="/main.css"></head><body></body></html>'
  ]
  const { html, injected } = feedChunks(create("https://example.com/"), chunks)
  assert(injected === 2, `expected 2 preloads, got ${injected}`)
  assert(html.includes("early-hint"), "missing injected preload markers")
}

function testQuotedAttributesAndAsyncSkip() {
  const html = `<!DOCTYPE html><html><head>
    <script async src="/skip.js"></script>
    <script src='/app.js'></script>
    <link rel="stylesheet" href="/a.css" />
  </head></html>`
  const { injected } = feedChunks(create("https://example.com/page"), [html])
  assert(injected === 2, `expected 2 preloads, got ${injected}`)
}

function testIncompleteSuffixWaits() {
  const scanner = create("https://example.com/")
  const first = scanner.appendText("<html><head><script src='/a.js'")
  assert(first.status === "pending", "should wait for closing >")
  const second = scanner.appendText("></script></head>")
  assert(second.status === "finalized", "should finalize after tag completes")
}

function testPassthroughNoHead() {
  const big = `${"x".repeat(20000)}`
  const result = feedChunks(create("https://example.com/"), [big])
  assert(result.injected === 0, "no head should not inject")
  assert(result.html === big, "buffer should remain unchanged")
}

function testNormalizeAssetUrl() {
  const a = api.normalizeAssetUrl("https://EXAMPLE.com:443/app.js?b=2&a=1#frag")
  const b = api.normalizeAssetUrl("https://example.com/app.js?a=1&b=2")
  assert(a === b, `normalized URLs should match: ${a} vs ${b}`)
  assert(api.assetKey("/app.js?a=1&b=2", "https://example.com/") === b, "assetKey should normalize relative paths")
}

function testDedupeExistingPreloadAndScript() {
  const html = `<html><head>
    <link rel="preload" href="/app.js" as="script">
    <link rel="stylesheet" href="/style.css">
    <script src="/app.js"></script>
  </head><body></body></html>`
  const { html: out, injected } = feedChunks(create("https://example.com/"), [html])
  assert(injected === 1, `expected 1 preload (style.css only), got ${injected}`)
  assert(countSubstring(out, 'data-aegisstream="early-hint"') === 1, "single injected hint")
  assert(!out.includes('early-hint" href="https://example.com/app.js"'), "must not duplicate app.js preload")
}

function testDedupeRelativeAndAbsolutePreload() {
  const html = `<html><head>
    <link rel="preload" href="https://example.com/app.js?a=1&b=2" as="script">
    <script src="/app.js?b=2&a=1"></script>
  </head></html>`
  const { injected } = feedChunks(create("https://example.com/page/"), [html])
  assert(injected === 0, `normalized preload dedupe failed: ${injected}`)
  const keyA = api.assetKey("https://example.com/app.js?b=2&a=1", "https://example.com/page/")
  const keyB = api.assetKey("/app.js?b=2&a=1", "https://example.com/page/")
  assert(keyA === keyB, "absolute and relative forms should share one key")
}

function testQuoteAttackHeadClose() {
  const html = `<html><head>
<script src="a.js?foo='></head>'"></script>
<script src="b.js"></script>
</head><body></body></html>`
  const headClose = api.findHeadCloseStart(html, html.length)
  assert(headClose > 0, "should find real </head>")
  assert(html.slice(headClose, headClose + 7).toLowerCase() === "</head>", "head close should be real tag")

  const { html: out, injected } = feedChunks(create("https://example.com/"), [html])
  assert(injected === 2, `expected preloads for a.js and b.js, got ${injected}`)
  const closeIdx = out.toLowerCase().lastIndexOf("</head>")
  assert(closeIdx > headClose, "injection must be inserted before the real </head> tag")
  assert(out.slice(Math.max(0, closeIdx - 400), closeIdx).includes("early-hint"), "hints precede </head>")
  assert(!out.includes("foo='></head>'\"></head>"), "must not splice inside attribute value")
  assert(api.findHeadCloseStart(out, out.length) === closeIdx, "tag-aware close must match real tag")
}

function testEvilMalformedHead() {
  const html = `<html><head>

<!-- fake -->
<script src="a.js"></script>

<link rel="stylesheet"
href="style.css">

<script
src="b.js"></script>

</head><body></body></html>`
  const { html: out, injected, reason } = feedChunks(create("https://example.com/"), [html])
  assert(reason === "injected" || reason === "no-candidates", `unexpected reason: ${reason}`)
  assert(injected >= 1, `expected at least b.js preload, got ${injected}`)
  const hints = countSubstring(out, 'data-aegisstream="early-hint"')
  assert(hints === injected, `hint count ${hints} must match injected ${injected}`)
  assert(out.includes("b.js"), "missing b.js resource")
  assert(countSubstring(out, "early-hint") === injected, "stable hint count")
}

function testEvilCommentWithFakeTags() {
  const html = `<html><head><!-- <script src="evil.js"></script> <link rel="stylesheet" href="evil.css"> -->
<script src="real.js"></script>
</head></html>`
  const { html: out, injected } = feedChunks(create("https://example.com/"), [html])
  assert(injected === 1, `only real.js should preload, got ${injected}`)
  assert(out.includes("early-hint") && out.includes("real.js"), "preload real.js")
  assert(!/early-hint[^>]*evil\.js/i.test(out), "comment decoys must not become preload targets")
}

testSplitScriptTag()
testQuotedAttributesAndAsyncSkip()
testIncompleteSuffixWaits()
testPassthroughNoHead()
testNormalizeAssetUrl()
testDedupeExistingPreloadAndScript()
testDedupeRelativeAndAbsolutePreload()
testQuoteAttackHeadClose()
testEvilMalformedHead()
testEvilCommentWithFakeTags()
console.log("html-head-scanner tests passed")
