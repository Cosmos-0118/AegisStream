/**
 * Regression: delegated prefetch must be addressed to the player's frame.
 *
 * Field failure: content scripts are injected with all_frames:true, and this
 * delegate sent the segment list with a frameless chrome.tabs.sendMessage. Every
 * frame therefore received the list and every frame fetched every URL. Measured
 * on a 2-frame embed page: 116 segments delegated produced 236 StoreChunk
 * arrivals (2.03x). The extra copies are caught by the invariant-CRC check at
 * store time and logged as "duplicate suppressed", so nothing is corrupted —
 * but the dedup happens after the bytes are already on the wire, so the whole
 * cost is paid. In that session 81.9 MiB was fetched to keep 23.8 MiB.
 *
 * Contract:
 *  1. With a known player frame, exactly ONE send goes out, carrying that frameId.
 *  2. With no known frame, it falls back to the broadcast (never silently drops).
 *  3. If the targeted send throws (frame navigated away), it retries as a
 *     broadcast AND clears the stale frame id so the next call re-learns it.
 *
 * Run: node test/background/prefetch/scheduler/page-delegate-frame-targeting.test.js
 */
"use strict"

const fs = require("fs")
const path = require("path")
const vm = require("vm")

const modulePath = path.join(
  __dirname,
  "../../../../src/background/prefetch/scheduler/page-delegate.js"
)

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makeHarness({ playerFrameId, failTargeted = false } = {}) {
  const sends = []
  const tabState = { networkGeneration: 7 }
  if (playerFrameId !== undefined) tabState.playerFrameId = playerFrameId
  tabState.playerFrameAuthoritative = true

  const sandbox = {
    self: {
      AegisBackground: {
        constants: { DELEGATE_BATCH_COALESCE_MS: 0 },
        state: { playlistByTab: new Map([[1, tabState]]) },
        addLog: () => {},
        // Non-destructive: keeps delegatePrefetchToPage on the straight path to
        // the send without exercising the generation-bump machinery.
        isDestructiveDelegateSource: () => false
      }
    },
    chrome: {
      tabs: {
        sendMessage: async (tabId, message, opts) => {
          sends.push({ tabId, message, opts })
          if (failTargeted && opts && Number.isFinite(opts.frameId)) {
            throw new Error("Could not establish connection")
          }
        }
      }
    },
    setTimeout,
    clearTimeout
  }
  sandbox.globalThis = sandbox
  vm.runInContext(fs.readFileSync(modulePath, "utf8"), vm.createContext(sandbox))
  return { ns: sandbox.self.AegisBackground, sends, tabState }
}

const URLS = ["https://cdn.example.com/a.ts", "https://cdn.example.com/b.ts"]

;(async () => {
  // ── 1. Known player frame -> one targeted send ─────────────────────────────
  {
    const { ns, sends } = makeHarness({ playerFrameId: 3 })
    const ok = await ns.delegatePrefetchToPage(1, URLS, { skipCoalesce: true })
    assert(ok === true, "a targeted delegate must report success")
    assert(sends.length === 1, `expected exactly 1 send, got ${sends.length}`)
    assert(
      sends[0].opts && sends[0].opts.frameId === 3,
      `send MUST carry the player frameId, got ${JSON.stringify(sends[0].opts)}`
    )
    assert(
      sends[0].message.type === "AegisStream:PrefetchSegments" &&
        sends[0].message.urls.length === 2,
      "the targeted send must still carry the full segment list"
    )
    console.log("  targeted to player frame: OK")
  }

  // ── 2. No known frame -> broadcast fallback ────────────────────────────────
  {
    const { ns, sends } = makeHarness({})
    const ok = await ns.delegatePrefetchToPage(1, URLS, { skipCoalesce: true })
    assert(ok === true, "the broadcast fallback must report success")
    assert(sends.length === 1, `expected exactly 1 send, got ${sends.length}`)
    assert(
      sends[0].opts === undefined,
      "with no known frame the send must be a plain broadcast"
    )
    console.log("  broadcast when frame unknown: OK")
  }

  // ── 3. Stale frame -> broadcast retry, and the id is cleared ───────────────
  {
    const { ns, sends, tabState } = makeHarness({ playerFrameId: 9, failTargeted: true })
    const ok = await ns.delegatePrefetchToPage(1, URLS, { skipCoalesce: true })
    assert(ok === true, "a stale frame must not leave the tab unable to prefetch")
    assert(sends.length === 2, `expected targeted-then-broadcast, got ${sends.length} sends`)
    assert(sends[0].opts.frameId === 9, "first send should have tried the known frame")
    assert(sends[1].opts === undefined, "second send must be the broadcast fallback")
    assert(
      tabState.playerFrameId === null,
      `a frame that refused delivery must be forgotten, got ${tabState.playerFrameId}`
    )
    console.log("  stale frame falls back and is cleared: OK")
  }

  console.log("page-delegate-frame-targeting.test.js: OK")
})().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
