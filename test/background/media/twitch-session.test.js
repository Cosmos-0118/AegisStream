import { describe, it } from "node:test"
import assert from "node:assert/strict"

function isTwitchSsaiOrAdUrl(url) {
  if (typeof url !== "string" || !url) return false
  const lower = url.toLowerCase()
  if (lower.includes("amazon-adsystem")) return true
  try {
    const parsed = new URL(url)
    const host = (parsed.hostname || "").toLowerCase()
    const path = parsed.pathname || ""
    const pathLower = path.toLowerCase()
    if (/\/ads?\//.test(pathLower)) return true
    if (/index-muted/i.test(path) || /index-muted/i.test(parsed.href)) return true
    if (/surestream|stitched[-_]?ad|\/ssai\//i.test(`${path}${parsed.search}`)) return true
    if (host.endsWith(".cloudfront.net") && !host.includes("ttvnw.net") && !host.includes("jtvnw.net")) {
      return true
    }
    if (lower.includes("cloudfront") && /\/ads?\//.test(pathLower)) return true
    return false
  } catch {
    return /\/ad\/|\/ads\/|index-muted|amazon-adsystem/i.test(lower)
  }
}

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
  if (isTwitchSsaiOrAdUrl(url)) return url
  if (!session?.token || !session?.sig) return url
  const parsed = new URL(url)
  if (!parsed.searchParams.has("token")) parsed.searchParams.set("token", session.token)
  if (!parsed.searchParams.has("sig")) parsed.searchParams.set("sig", session.sig)
  return parsed.toString()
}

function shouldCaptureSession(url) {
  if (!url.includes("ttvnw.net") && !url.includes("jtvnw.net")) return false
  if (isTwitchSsaiOrAdUrl(url)) return false
  return Boolean(extractAuthParams(url))
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
    const segment = "https://video-weaver.dfw02.hls.ttvnw.net/v1/segment/0.ts"
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

describe("Twitch SSAI filter guard", () => {
  it("flags ad path segments on ttvnw", () => {
    assert.equal(
      isTwitchSsaiOrAdUrl(
        "https://video-weaver.dfw02.hls.ttvnw.net/ad/segment/0.ts?token=x&sig=y"
      ),
      true
    )
  })

  it("flags index-muted interleaved ad variant playlists", () => {
    assert.equal(
      isTwitchSsaiOrAdUrl(
        "https://video-weaver.dfw02.hls.ttvnw.net/chunked/index-muted-5NN47WL83O.m3u8?token=x&sig=y"
      ),
      true
    )
  })

  it("flags amazon-adsystem hosts", () => {
    assert.equal(
      isTwitchSsaiOrAdUrl("https://s.amazon-adsystem.com/ads/playlist.m3u8?token=a&sig=b"),
      true
    )
  })

  it("flags standalone cloudfront ad distributions", () => {
    assert.equal(
      isTwitchSsaiOrAdUrl("https://d123.cloudfront.net/v1/ad/segment.ts?token=a&sig=b"),
      true
    )
  })

  it("allows standard video-weaver stream URLs", () => {
    assert.equal(
      isTwitchSsaiOrAdUrl(
        "https://video-weaver.dfw02.hls.ttvnw.net/v1/playlist/main.m3u8?token=stream&sig=stream-sig"
      ),
      false
    )
  })

  it("does not capture session tokens from SSAI URLs", () => {
    const streamUrl =
      "https://video-weaver.dfw02.hls.ttvnw.net/v1/playlist/main.m3u8?token=stream&sig=stream-sig"
    const adUrl =
      "https://video-weaver.dfw02.hls.ttvnw.net/chunked/index-muted-AD123.m3u8?token=ad&sig=ad-sig"

    assert.equal(shouldCaptureSession(streamUrl), true)
    assert.equal(shouldCaptureSession(adUrl), false)
  })

  it("does not stitch stream tokens onto muted ad chunks", () => {
    const adChunk =
      "https://video-weaver.dfw02.hls.ttvnw.net/chunked/index-muted-AD123/0.ts"
    const stitched = applySessionToUrl(adChunk, { token: "stream", sig: "stream-sig" })
    assert.equal(stitched, adChunk)
    assert.equal(new URL(stitched).searchParams.get("token"), null)
  })
})
