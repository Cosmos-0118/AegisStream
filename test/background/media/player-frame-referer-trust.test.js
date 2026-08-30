/**
 * Regression: only a trustworthy frame may supply the Referer for a media fetch.
 *
 * Field failure: content scripts are injected with all_frames:true, so a
 * reCAPTCHA iframe reports itself to notePlayerFrame exactly like the embed
 * does. It won the race, and the session DNR rule went out as
 * `Referer: https://www.recaptcha.net/` on a manifest fetch:
 *
 *   Media referer rule active for megap.shiora.site (referer=https://www.recaptcha.net/)
 *
 * The host answered 403 — the extension manufactured the very hotlink rejection
 * the rule exists to prevent. That burned a manifest-refresh retry and the tab
 * went on to latch auth_expired. A wrong Referer is strictly worse than none.
 *
 * Contract:
 *  1. A third-party utility frame is never recorded as the player frame.
 *  2. It can never supply a referer, even as the tab-page fallback.
 *  3. A weak (non-authoritative) signal routes messages but does NOT supply a
 *     referer — only a frame that actually delivered playlist content does.
 *  4. A genuine embed frame still works.
 *
 * Run: node test/background/media/player-frame-referer-trust.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const modulePath = path.join(__dirname, "../../../src/background/media/site-policy.js")

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness() {
  const tabState = {}
  const sandbox = {
    self: {
      AegisBackground: {
        state: {
          playlistByTab: new Map([[1, tabState]]),
          tabPageHostByTab: new Map(),
          tabPageUrlFingerprintByTab: new Map()
        },
        addLog: () => {},
        getPageUrlFingerprint: (u) => u
      }
    },
    URL,
    console
  }
  sandbox.globalThis = sandbox
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
  return { ns: sandbox.self.AegisBackground, tabState }
}

const CAPTCHA = "https://www.recaptcha.net/recaptcha/api2/anchor?k=abc"
const EMBED = "https://megaplay.buzz/stream/s-2/1234/sub"

// ── 1 & 2. A utility frame is never the player and never a referer ──────────
{
  const { ns, tabState } = makeHarness()
  ns.notePlayerFrame(1, 2, CAPTCHA, { authoritative: true })
  assert(
    tabState.playerFrameId === undefined && tabState.playerFrameUrl === undefined,
    `a reCAPTCHA frame must not be adopted as the player frame, got id=${tabState.playerFrameId} url=${tabState.playerFrameUrl}`
  )
  assert(
    ns.getPlayerRefererUrl(1) === null,
    `a reCAPTCHA frame must never supply a referer, got ${ns.getPlayerRefererUrl(1)}`
  )

  // ...and not through the page fallback either.
  ns.noteTabPageUrl(1, CAPTCHA)
  assert(
    ns.getPlayerRefererUrl(1) === null,
    `the page fallback must be screened too, got ${ns.getPlayerRefererUrl(1)}`
  )
  console.log("  utility frame rejected as frame and as referer: OK")
}

// ── 3. A weak signal routes, but does not supply a referer ──────────────────
{
  const { ns, tabState } = makeHarness()
  ns.notePlayerFrame(1, 4, EMBED)
  assert(tabState.playerFrameId === 4, "a weak signal should still record the frame for routing")
  assert(
    ns.getPlayerRefererUrl(1) === null,
    `a non-authoritative frame must not supply a referer, got ${ns.getPlayerRefererUrl(1)}`
  )
  console.log("  weak signal routes but does not set referer: OK")
}

// ── 4. A genuine embed frame still works ────────────────────────────────────
{
  const { ns, tabState } = makeHarness()
  ns.notePlayerFrame(1, 4, EMBED, { authoritative: true })
  assert(tabState.playerFrameId === 4, "an authoritative embed frame must be adopted")
  assert(
    ns.getPlayerRefererUrl(1) === EMBED,
    `an authoritative embed frame must supply the referer, got ${ns.getPlayerRefererUrl(1)}`
  )
  console.log("  authoritative embed frame supplies referer: OK")
}

console.log("player-frame-referer-trust.test.js: OK")
