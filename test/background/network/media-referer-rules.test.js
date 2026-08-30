/**
 * Regression: the extension's own media fetches must present the page's
 * Referer/Origin.
 *
 * Field failure: manifest-fetch-coalescer issues a bare service-worker
 * `fetch(url, {credentials:"include"})` with no headers. Hosts with hotlink
 * protection answered it `HTTP 403` while the identical request from the page
 * succeeded. Referer is a forbidden header name for fetch(), so it can only be
 * applied via declarativeNetRequest.
 *
 * Contract:
 *  1. A rule is installed for the media host carrying the page origin.
 *  2. It is SESSION-scoped and restricted to tabIds [-1] — extension-initiated
 *     requests only. The page's own requests must never be rewritten, so a
 *     wrong referer cannot break playback.
 *  3. Repeat calls with the same referer do not reinstall (called per fetch).
 *  4. A changed referer replaces the rule under the same id.
 *  5. Same-origin media needs no rule.
 *
 * Run: node test/background/network/media-referer-rules.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const modulePath = path.join(__dirname, "../../../src/background/network/media-referer-rules.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness() {
  const calls = []
  const sandbox = {
    self: { AegisBackground: { addLog: () => {} } },
    URL,
    chrome: {
      declarativeNetRequest: {
        updateSessionRules: async (arg) => { calls.push(arg) }
      }
    }
  }
  sandbox.globalThis = sandbox
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
  return { ns: sandbox.self.AegisBackground, calls }
}

const MEDIA = "https://s1.akirax.buzz/ag64abc/1080p/index.m3u8"
const PAGE = "https://vidtube.site/stream/xyz/dub"

// ── 1 & 2. Rule shape ────────────────────────────────────────────────────────
{
  const { ns, calls } = makeHarness()
  ;(async () => {
    const ok = await ns.ensureMediaRefererRule(MEDIA, PAGE)
    assert(ok === true, "installing a rule for a cross-origin media host must succeed")
    assert(calls.length === 1, `expected 1 session-rule update, got ${calls.length}`)

    const rule = calls[0].addRules[0]
    assert(rule.action.type === "modifyHeaders", "must modify headers")

    const headers = Object.fromEntries(rule.action.requestHeaders.map((h) => [h.header, h.value]))
    assert(
      headers.Referer === "https://vidtube.site/",
      `cross-origin requests send origin-only referer, got ${headers.Referer}`
    )
    assert(headers.Origin === "https://vidtube.site", `unexpected origin ${headers.Origin}`)
    assert(
      rule.condition.urlFilter === "||s1.akirax.buzz^",
      `rule must be scoped to the media host, got ${rule.condition.urlFilter}`
    )
    assert(
      Array.isArray(rule.condition.tabIds) &&
        rule.condition.tabIds.length === 1 &&
        rule.condition.tabIds[0] === -1,
      "rule MUST be restricted to tabIds [-1] so the page's own requests are never rewritten"
    )
    console.log("  rule shape + extension-only scope: OK")

    // ── 3. Idempotent ────────────────────────────────────────────────────────
    await ns.ensureMediaRefererRule(MEDIA, PAGE)
    await ns.ensureMediaRefererRule(MEDIA, PAGE)
    assert(calls.length === 1, `repeat calls must not reinstall, got ${calls.length} updates`)
    console.log("  idempotent: OK")

    // ── 4. Referer change replaces in place ──────────────────────────────────
    await ns.ensureMediaRefererRule(MEDIA, "https://other.example/watch/1")
    assert(calls.length === 2, "a changed referer must reinstall")
    assert(
      calls[1].removeRuleIds[0] === calls[1].addRules[0].id,
      "replacement must reuse the same rule id"
    )
    assert(calls[1].addRules[0].id === rule.id, "host must keep its rule id")
    console.log("  referer change: OK")

    // ── 5. Same-origin media needs no rule ───────────────────────────────────
    const before = calls.length
    const same = await ns.ensureMediaRefererRule(
      "https://vidtube.site/media/index.m3u8",
      PAGE
    )
    assert(same === false, "same-origin media must not install a rule")
    assert(calls.length === before, "same-origin media must not touch session rules")

    assert(
      (await ns.ensureMediaRefererRule(MEDIA, "not a url")) === false,
      "an unusable referer must be declined, not thrown"
    )
    assert(
      (await ns.ensureMediaRefererRule("not a url", PAGE)) === false,
      "an unusable media url must be declined, not thrown"
    )
    console.log("  no-op cases: OK")

    console.log("media-referer-rules.test.js: OK")
  })().catch((e) => {
    console.error(e.message)
    process.exit(1)
  })
}
