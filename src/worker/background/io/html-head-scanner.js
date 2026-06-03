(() => {
var ns = (self.AegisBackground ||= {})

const MAX_HEAD_SCAN_CHARS = 98304
const MAX_HOLD_BACK_CHARS = 2048
const MIN_BUFFER_BEFORE_HEAD = 16384
const MIN_BUFFER_IN_HEAD = 12288
const HEAD_CLOSE = "</head>"

const SKIP_URL_SCHEMES = /^(?:data:|blob:|javascript:|mailto:|tel:|#)/i

function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
}

function resolveAssetUrl(href, pageUrl) {
  if (typeof href !== "string") return null
  const trimmed = href.trim()
  if (!trimmed || SKIP_URL_SCHEMES.test(trimmed)) return null
  try {
    const resolved = new URL(trimmed, pageUrl)
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null
    return resolved.toString()
  } catch {
    return null
  }
}

/** Canonical key for dedupe: absolute URL with stable host, path, and query encoding. */
function normalizeAssetUrl(resolvedUrl) {
  if (!resolvedUrl) return null
  try {
    const parsed = new URL(resolvedUrl)
    parsed.hash = ""
    parsed.hostname = parsed.hostname.toLowerCase()
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = ""
    }

    if (parsed.search) {
      const sorted = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
      parsed.search = ""
      for (const [key, value] of sorted) {
        parsed.searchParams.append(key, value)
      }
    }

    return parsed.toString()
  } catch {
    return null
  }
}

function assetKey(href, pageUrl) {
  const resolved = resolveAssetUrl(href, pageUrl)
  if (!resolved) return null
  return normalizeAssetUrl(resolved)
}

function indexOfInsensitive(haystack, needle, fromIndex = 0) {
  return haystack.toLowerCase().indexOf(needle.toLowerCase(), fromIndex)
}

/** Find `>` for tag starting at `<`, respecting quoted attribute values. */
function findTagCloseIndex(html, start, limit = html.length) {
  if (html[start] !== "<") return -1
  let quote = null
  for (let i = start + 1; i < limit; i += 1) {
    const ch = html[i]
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ">") return i
  }
  return -1
}

function parseAttributes(attrSource) {
  const attrs = Object.create(null)
  if (!attrSource) return attrs

  let i = 0
  const len = attrSource.length
  while (i < len) {
    while (i < len && /\s/.test(attrSource[i])) i += 1
    if (i >= len) break

    const nameStart = i
    while (i < len && !/[\s=/>]/.test(attrSource[i])) i += 1
    if (nameStart === i) {
      i += 1
      continue
    }
    const name = attrSource.slice(nameStart, i).toLowerCase()
    while (i < len && /\s/.test(attrSource[i])) i += 1

    let value = ""
    if (attrSource[i] === "=") {
      i += 1
      while (i < len && /\s/.test(attrSource[i])) i += 1
      const q = attrSource[i]
      if (q === '"' || q === "'") {
        i += 1
        const vStart = i
        while (i < len && attrSource[i] !== q) i += 1
        value = attrSource.slice(vStart, i)
        if (i < len) i += 1
      } else {
        const vStart = i
        while (i < len && !/[\s>]/.test(attrSource[i])) i += 1
        value = attrSource.slice(vStart, i)
      }
    }
    attrs[name] = value
  }
  return attrs
}

function parseTag(html, start, limit) {
  const close = findTagCloseIndex(html, start, limit)
  if (close < 0) return { incomplete: true, start }

  const inner = html.slice(start + 1, close)
  let cursor = 0
  while (cursor < inner.length && /[\s/?]/.test(inner[cursor])) cursor += 1
  const nameStart = cursor
  while (cursor < inner.length && /[a-zA-Z0-9:-]/.test(inner[cursor])) cursor += 1
  const tagName = inner.slice(nameStart, cursor).toLowerCase()
  const attrs = parseAttributes(inner.slice(cursor))

  return {
    incomplete: false,
    start,
    end: close + 1,
    tagName,
    attrs,
    selfClosing: /\/\s*$/.test(inner)
  }
}

function hasRelToken(relValue, token) {
  if (!relValue) return false
  return relValue
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .includes(token)
}

function hasBooleanAttr(attrs, name) {
  return Object.prototype.hasOwnProperty.call(attrs, name)
}

function isDeferScript(attrs) {
  if (hasBooleanAttr(attrs, "async")) return true
  if (hasBooleanAttr(attrs, "defer")) return true
  const type = (attrs.type || "").toLowerCase()
  if (type === "module") return true
  if (hasBooleanAttr(attrs, "nomodule")) return true
  return false
}

function isUrlClaimed(key, seen, existing) {
  if (!key) return true
  if (existing.has(key) || seen.has(key)) return true
  return false
}

function candidateFromTag(tag, pageUrl, seen, existing) {
  if (!tag || tag.incomplete) return null

  if (tag.tagName === "script") {
    if (isDeferScript(tag.attrs)) return null
    const src = tag.attrs.src
    if (!src) return null
    const key = assetKey(src, pageUrl)
    const url = key ? resolveAssetUrl(src, pageUrl) : null
    if (!url || isUrlClaimed(key, seen, existing)) return null
    return { url, as: "script", key }
  }

  if (tag.tagName === "link") {
    const rel = tag.attrs.rel || ""
    const href = tag.attrs.href
    if (!href) return null

    if (hasRelToken(rel, "stylesheet")) {
      const key = assetKey(href, pageUrl)
      const url = key ? resolveAssetUrl(href, pageUrl) : null
      if (!url || isUrlClaimed(key, seen, existing)) return null
      return { url, as: "style", key }
    }

    if (hasRelToken(rel, "modulepreload")) {
      const key = assetKey(href, pageUrl)
      const url = key ? resolveAssetUrl(href, pageUrl) : null
      if (!url || isUrlClaimed(key, seen, existing)) return null
      return { url, as: "script", key }
    }

    if (hasRelToken(rel, "preload")) {
      const as = (tag.attrs.as || "").toLowerCase()
      if (as !== "style" && as !== "script" && as !== "font") return null
      const key = assetKey(href, pageUrl)
      const url = key ? resolveAssetUrl(href, pageUrl) : null
      if (!url || isUrlClaimed(key, seen, existing)) return null
      return { url, as: as === "font" ? "font" : as, key }
    }
  }

  return null
}

/** URLs already declared via <link rel="preload|modulepreload"> in the head. */
function noteExistingPreloadLink(tag, pageUrl, existing) {
  if (!tag || tag.incomplete || tag.tagName !== "link") return
  const href = tag.attrs.href
  if (!href) return
  const rel = tag.attrs.rel || ""
  if (!hasRelToken(rel, "preload") && !hasRelToken(rel, "modulepreload")) return
  const key = assetKey(href, pageUrl)
  if (key) existing.add(key)
}

function findHeadOpenEnd(html, limit) {
  const idx = indexOfInsensitive(html, "<head", 0)
  if (idx < 0 || idx >= limit) return -1
  const close = findTagCloseIndex(html, idx, limit)
  return close < 0 ? -1 : close + 1
}

function walkTagsFrom(buffer, start, parseLimit, onTag) {
  let cursor = Math.max(0, start)
  while (cursor < parseLimit) {
    const lt = buffer.indexOf("<", cursor)
    if (lt < 0 || lt >= parseLimit) break

    if (buffer.startsWith("<!--", lt)) {
      const commentEnd = buffer.indexOf("-->", lt + 4)
      if (commentEnd < 0 || commentEnd >= parseLimit) return { incomplete: true, cursor: lt }
      cursor = commentEnd + 3
      continue
    }

    if (buffer[lt + 1] === "/" || buffer[lt + 1] === "!" || buffer[lt + 1] === "?") {
      const tag = parseTag(buffer, lt, parseLimit)
      if (tag.incomplete) return { incomplete: true, cursor: lt }
      const stop = onTag(tag, lt, buffer)
      if (stop === true) return { done: true, cursor: tag.end }
      cursor = tag.end
      continue
    }

    const tag = parseTag(buffer, lt, parseLimit)
    if (tag.incomplete) return { incomplete: true, cursor: lt }
    const stop = onTag(tag, lt, buffer)
    if (stop === true) return { done: true, cursor: tag.end }
    cursor = tag.end
  }
  return { done: false, cursor }
}

function walkTags(buffer, parseLimit, onTag) {
  return walkTagsFrom(buffer, 0, parseLimit, onTag)
}

function getHeadRegionBounds(buffer, parseLimit) {
  const headOpenEnd = findHeadOpenEnd(buffer, parseLimit)
  const headClose = findHeadCloseStart(buffer, parseLimit)
  return {
    start: headOpenEnd >= 0 ? headOpenEnd : 0,
    end: headClose >= 0 ? headClose : parseLimit
  }
}

/** Tag-aware </head> detection (immune to </head> inside quoted attributes). */
function findHeadCloseStart(html, limit) {
  const headOpenEnd = findHeadOpenEnd(html, limit)
  if (headOpenEnd < 0) return -1

  let found = -1
  const walk = walkTagsFrom(html, headOpenEnd, limit, (tag, lt) => {
    if (tag.tagName !== "head") return false
    if (html[lt + 1] === "/") {
      found = lt
      return true
    }
    return false
  })

  if (found >= 0) return found
  if (walk.incomplete) return -1
  return -1
}

function hasCompleteHeadClose(buffer, parseLimit) {
  return findHeadCloseStart(buffer, parseLimit) >= 0
}

function isPrefixOfHeadClose(tailLower) {
  const target = HEAD_CLOSE
  if (tailLower.length >= target.length) return false
  return target.startsWith(tailLower)
}

function findPartialHeadCloseStart(buffer) {
  const scanStart = Math.max(0, buffer.length - (HEAD_CLOSE.length - 1))
  const tailLower = buffer.slice(scanStart).toLowerCase()
  for (let len = 1; len < HEAD_CLOSE.length; len += 1) {
    const suffix = tailLower.slice(-len)
    if (isPrefixOfHeadClose(suffix)) return buffer.length - len
  }
  return -1
}

function findIncompleteTagStart(buffer) {
  const scanStart = Math.max(0, buffer.length - MAX_HOLD_BACK_CHARS)
  const tail = buffer.slice(scanStart)
  const lastLt = tail.lastIndexOf("<")
  if (lastLt < 0) return -1
  const fragment = tail.slice(lastLt)
  if (findTagCloseIndex(fragment, 0, fragment.length) >= 0) return -1
  return scanStart + lastLt
}

function hasIncompleteSuffix(buffer) {
  return findPartialHeadCloseStart(buffer) >= 0 || findIncompleteTagStart(buffer) >= 0
}

function getParseLimit(buffer) {
  if (hasCompleteHeadClose(buffer, buffer.length)) return buffer.length
  const partialClose = findPartialHeadCloseStart(buffer)
  if (partialClose >= 0) return partialClose
  const incompleteTag = findIncompleteTagStart(buffer)
  if (incompleteTag >= 0) return incompleteTag
  return buffer.length
}

function hasHeadOpen(buffer) {
  return indexOfInsensitive(buffer, "<head", 0) >= 0
}

function collectExistingNormalizedKeys(buffer, pageUrl, parseLimit) {
  const existing = new Set()
  const { start, end } = getHeadRegionBounds(buffer, parseLimit)
  walkTagsFrom(buffer, start, end, (tag) => {
    noteExistingPreloadLink(tag, pageUrl, existing)
    return false
  })
  return existing
}

function collectCandidatesFromBuffer(buffer, pageUrl, seen, parseLimit) {
  const existing = collectExistingNormalizedKeys(buffer, pageUrl, parseLimit)
  const candidates = []
  const { start, end } = getHeadRegionBounds(buffer, parseLimit)

  walkTagsFrom(buffer, start, end, (tag) => {
    const candidate = candidateFromTag(tag, pageUrl, seen, existing)
    if (candidate) {
      seen.add(candidate.key)
      candidates.push(candidate)
    }
    return false
  })

  return candidates
}

function buildPreloadMarkup(candidates) {
  return candidates
    .map((entry) => {
      const as = entry.as
      let extra = ""
      if (as === "font" && /\.woff2(\?|$)/i.test(entry.url)) {
        extra = ' type="font/woff2" crossorigin'
      }
      return `<link rel="preload" href="${escapeHtmlAttr(entry.url)}" as="${as}"${extra} data-aegisstream="early-hint">`
    })
    .join("")
}

function injectPreloadMarkup(buffer, markup) {
  if (!markup) return buffer
  const parseLimit = buffer.length
  const headClose = findHeadCloseStart(buffer, parseLimit)
  if (headClose >= 0) {
    return buffer.slice(0, headClose) + markup + buffer.slice(headClose)
  }
  const headOpenEnd = findHeadOpenEnd(buffer, parseLimit)
  if (headOpenEnd >= 0) {
    return buffer.slice(0, headOpenEnd) + markup + buffer.slice(headOpenEnd)
  }
  return buffer
}

function shouldContinueBuffering(buffer) {
  if (buffer.length >= MAX_HEAD_SCAN_CHARS) return false
  if (hasCompleteHeadClose(buffer, buffer.length)) return false
  if (hasIncompleteSuffix(buffer)) return true

  if (!hasHeadOpen(buffer)) {
    return buffer.length < MIN_BUFFER_BEFORE_HEAD
  }

  if (buffer.length < MIN_BUFFER_IN_HEAD) return true
  return true
}

function finalizeBuffer(buffer, pageUrl, seen) {
  const parseLimit = getParseLimit(buffer)

  if (!hasHeadOpen(buffer)) {
    return { html: buffer, injectedCount: 0, reason: "no-head" }
  }

  const candidates = collectCandidatesFromBuffer(buffer, pageUrl, seen, parseLimit)
  const markup = buildPreloadMarkup(candidates)
  const html = injectPreloadMarkup(buffer, markup)
  return {
    html,
    injectedCount: candidates.length,
    reason: candidates.length > 0 ? "injected" : "no-candidates"
  }
}

function createStreamingHeadScanner(pageUrl) {
  let buffer = ""
  let finalized = false
  let passthrough = false
  const seen = new Set()

  return {
    appendText(chunkText) {
      if (passthrough || finalized) {
        buffer += chunkText
        return { status: finalized ? "done" : "passthrough" }
      }
      buffer += chunkText

      if (shouldContinueBuffering(buffer)) {
        return { status: "pending" }
      }

      try {
        const result = finalizeBuffer(buffer, pageUrl, seen)
        buffer = result.html
        finalized = true
        return {
          status: "finalized",
          html: buffer,
          injectedCount: result.injectedCount,
          reason: result.reason
        }
      } catch {
        passthrough = true
        finalized = true
        return { status: "passthrough", html: buffer, reason: "parse-error" }
      }
    },
    finalizeRemainder() {
      if (passthrough || !finalized) {
        if (!finalized && buffer.length > 0) {
          try {
            const result = finalizeBuffer(buffer, pageUrl, seen)
            buffer = result.html
            finalized = true
            return {
              html: buffer,
              injectedCount: result.injectedCount,
              reason: result.reason
            }
          } catch {
            passthrough = true
          }
        }
      }
      return { html: buffer, injectedCount: 0, reason: passthrough ? "passthrough" : "flush" }
    },
    enterPassthrough() {
      passthrough = true
      finalized = true
    },
    isPassthrough() {
      return passthrough
    },
    isFinalized() {
      return finalized
    }
  }
}

ns.MAX_HEAD_SCAN_CHARS = MAX_HEAD_SCAN_CHARS
ns.createStreamingHeadScanner = createStreamingHeadScanner
ns._htmlHeadScanner = {
  findTagCloseIndex,
  parseTag,
  normalizeAssetUrl,
  assetKey,
  collectCandidatesFromBuffer,
  collectExistingNormalizedKeys,
  findHeadCloseStart,
  shouldContinueBuffering,
  hasIncompleteSuffix,
  getParseLimit,
  finalizeBuffer
}
})()
