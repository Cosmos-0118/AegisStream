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

function hasOnlyIdentityQuery(urlObj) {
  let hasIdentity = false
  for (const key of urlObj.searchParams.keys()) {
    const normalized = key.toLowerCase()
    if (constants.IDENTITY_QUERY_PARAMS.has(normalized)) {
      hasIdentity = true
      continue
    }
    return false
  }
  return hasIdentity
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
        sortedParamsUrl(parsed, (key) => !constants.VOLATILE_QUERY_PARAMS.has(key.toLowerCase()))
      )
      if (hasIdentityQuery(parsed)) {
        pushVariant(
          sortedParamsUrl(parsed, (key) => constants.IDENTITY_QUERY_PARAMS.has(key.toLowerCase()))
        )
      }
      if (!hasIdentityQuery(parsed) || hasOnlyIdentityQuery(parsed)) {
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
