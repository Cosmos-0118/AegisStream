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

function isUmpCacheKey(url) {
  return typeof url === "string" && url.startsWith("ump|")
}

function getUmpBodyHashFromCacheKey(cacheKey) {
  if (!isUmpCacheKey(cacheKey)) return null
  const lastPipe = cacheKey.lastIndexOf("|")
  if (lastPipe < 4 || lastPipe >= cacheKey.length - 1) return null
  const bodyHash = cacheKey.slice(lastPipe + 1)
  return /^[0-9a-f]{8,64}$/i.test(bodyHash) ? bodyHash : null
}

function buildCacheKeyVariants(rawUrl) {
  const normalizedUrl = stripHash(rawUrl)
  if (!normalizedUrl) return []
  if (isRangeCacheKey(normalizedUrl)) return [normalizedUrl]
  if (isUmpCacheKey(normalizedUrl)) {
    const variants = [normalizedUrl]
    const bodyHash = getUmpBodyHashFromCacheKey(normalizedUrl)
    if (bodyHash) {
      const hashOnly = `ump|${bodyHash}`
      if (hashOnly !== normalizedUrl) variants.push(hashOnly)
    }
    return variants.slice(0, constants.MAX_CACHE_KEY_VARIANTS)
  }

  const variants = []
  const seen = new Set()
  const pushVariant = (value) => {
    if (!value || seen.has(value)) return
    seen.add(value)
    variants.push(value)
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
ns.isUmpCacheKey = isUmpCacheKey
ns.getUmpBodyHashFromCacheKey = getUmpBodyHashFromCacheKey
})()
