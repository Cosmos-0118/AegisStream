(() => {
var ns = (self.AegisBackground ||= {})
const { constants } = ns

function stripHash(url) {
  if (typeof url !== "string") return null
  return url.split("#")[0]
}

function isRangeCacheKey(url) {
  return typeof url === "string" && url.startsWith("range|")
}

function sortedParamsUrl(urlObj, shouldKeepParam = () => true) {
  const entries = []
  for (const [key, value] of urlObj.searchParams.entries()) {
    if (!shouldKeepParam(key, value)) continue
    entries.push([key, value])
  }
  entries.sort(([aKey, aValue], [bKey, bValue]) => {
    if (aKey !== bKey) return aKey.localeCompare(bKey)
    return aValue.localeCompare(bValue)
  })

  const out = new URL(urlObj.toString())
  out.search = ""
  for (const [key, value] of entries) {
    out.searchParams.append(key, value)
  }
  return stripHash(out.toString())
}

function hasIdentityQuery(urlObj) {
  for (const key of urlObj.searchParams.keys()) {
    if (constants.IDENTITY_QUERY_PARAMS.has(key.toLowerCase())) return true
  }
  return false
}

function isVolatileQueryParam(key, value) {
  const normalized = String(key || "").toLowerCase()
  if (constants.VOLATILE_QUERY_PARAMS.has(normalized) || normalized.startsWith("_nc_")) return true
  // Long opaque values on non-identity keys are signed/session material in the
  // streams we support. Keep short functional selectors intact until the
  // identity-only fallback below, where they are deliberately excluded.
  return !constants.IDENTITY_QUERY_PARAMS.has(normalized) && String(value || "").length >= 32
}

function hasOnlyIdentityOrVolatileQuery(urlObj) {
  for (const [key, value] of urlObj.searchParams.entries()) {
    const normalized = key.toLowerCase()
    if (constants.IDENTITY_QUERY_PARAMS.has(normalized)) continue
    if (isVolatileQueryParam(key, value)) continue
    return false
  }
  return true
}

function buildCacheKeyVariants(rawUrl) {
  const normalizedUrl = stripHash(rawUrl)
  if (!normalizedUrl) return []
  if (isRangeCacheKey(normalizedUrl)) return [normalizedUrl]

  const variants = []
  const seen = new Set()
  const pushVariant = (value) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    variants.push(value)
  }

  const invariantKey =
    typeof ns.buildMediaInvariantKey === "function" ? ns.buildMediaInvariantKey(normalizedUrl) : null
  if (invariantKey) {
    pushVariant(invariantKey)
  }
  pushVariant(normalizedUrl)

  try {
    const parsed = new URL(normalizedUrl)
    if (parsed.search) {
      pushVariant(sortedParamsUrl(parsed))
      pushVariant(
        sortedParamsUrl(parsed, (key, value) => !isVolatileQueryParam(key, value))
      )
      // The identity allowlist is the sole query component permitted to
      // survive a rotation, but only when a real identity parameter exists.
      // Otherwise a path-only alias would merge functional selectors such as
      // ?quality=720 and ?quality=1080.
      if (hasIdentityQuery(parsed)) {
        pushVariant(
          sortedParamsUrl(parsed, (key) => constants.IDENTITY_QUERY_PARAMS.has(key.toLowerCase()))
        )
      }
      // Path-only is safe only when every present param is identity or volatile —
      // an unrecognized param (e.g. ?quality=720 vs ?quality=1080) is treated as
      // a functional selector and must not be erased by a path-only alias.
      if (hasOnlyIdentityOrVolatileQuery(parsed)) {
        pushVariant(`${parsed.origin}${parsed.pathname}`)
      }
    }
  } catch {
    // Non-URL cache keys remain valid exact keys.
  }
  return variants.slice(0, constants.MAX_CACHE_KEY_VARIANTS)
}

ns.stripHash = stripHash
ns.buildCacheKeyVariants = buildCacheKeyVariants
ns.isRangeCacheKey = isRangeCacheKey
})()
