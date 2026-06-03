import { describe, it } from "node:test"
import assert from "node:assert/strict"

// Inline minimal copies of session helpers for unit testing (service worker is not loaded in node:test).
function extractAuthParams(url) {
  try {
    const parsed = new URL(url)
    const token = parsed.searchParams.get("token")
    const sig = parsed.searchParams.get("sig")
    if (!token || !sig) return null
    return { token, sig }
  } catch {
    return null
  }
}

function applySessionToUrl(url, session) {
  if (!session?.token || !session?.sig) return url
  const parsed = new URL(url)
  if (!parsed.searchParams.has("token")) parsed.searchParams.set("token", session.token)
  if (!parsed.searchParams.has("sig")) parsed.searchParams.set("sig", session.sig)
  return parsed.toString()
}

describe("Twitch session URL stitching", () => {
  it("extracts token and sig from playlist URLs", () => {
    const auth = extractAuthParams(
      "https://usher.ttvnw.net/api/channel/hls/foo.m3u8?token=abc&sig=def"
    )
    assert.equal(auth.token, "abc")
    assert.equal(auth.sig, "def")
  })

  it("applies cached credentials to segment URLs missing query auth", () => {
    const segment =
      "https://video-weaver.dfw02.hls.ttvnw.net/v1/segment/0.ts"
    const stitched = applySessionToUrl(segment, { token: "cached-token", sig: "cached-sig" })
    const parsed = new URL(stitched)
    assert.equal(parsed.searchParams.get("token"), "cached-token")
    assert.equal(parsed.searchParams.get("sig"), "cached-sig")
  })

  it("does not overwrite existing token/sig on the target URL", () => {
    const url =
      "https://video-weaver.dfw02.hls.ttvnw.net/v1/segment/0.ts?token=live&sig=live-sig"
    const stitched = applySessionToUrl(url, { token: "stale", sig: "stale-sig" })
    const parsed = new URL(stitched)
    assert.equal(parsed.searchParams.get("token"), "live")
    assert.equal(parsed.searchParams.get("sig"), "live-sig")
  })
})
