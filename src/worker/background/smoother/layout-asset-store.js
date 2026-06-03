(() => {
var ns = (self.AegisBackground ||= {})

const STORAGE_KEY = "layoutAssetsByOrigin"
const MAX_PATHS_PER_ORIGIN = 48
const MAX_ASSETS_PER_PATH = 12
const MAX_SCRIPT_ASSETS = 6

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

function normalizeAssetEntry(entry) {
  if (!entry?.url || typeof entry.url !== "string") return null
  try {
    const parsed = new URL(entry.url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    const url = normalizeAssetUrl(parsed.toString())
    if (!url) return null
    const as = entry.as === "style" || entry.type === "style" ? "style" : "script"
    return { url, as }
  } catch {
    return null
  }
}

function dedupeAssets(assets) {
  const seen = new Set()
  const out = []
  for (const raw of assets || []) {
    const entry = normalizeAssetEntry(raw)
    if (!entry) continue
    const key = `${entry.as}|${entry.url}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
    if (out.length >= MAX_ASSETS_PER_PATH) break
  }
  return out
}

function normalizePathname(pathname) {
  if (!pathname || pathname === "") return "/"
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1)
  return pathname
}

async function readStore() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    const value = stored[STORAGE_KEY]
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

async function writeStore(store) {
  await chrome.storage.local.set({ [STORAGE_KEY]: store })
}

async function recordLayoutAssets(origin, pathname, assets, options = {}) {
  if (!origin || !Array.isArray(assets) || assets.length === 0) return []
  const incoming = dedupeAssets(assets)
  if (incoming.length === 0) return []

  const store = await readStore()
  const originKey = origin
  const pathKey = normalizePathname(pathname)
  const originBucket = store[originKey] && typeof store[originKey] === "object" ? store[originKey] : {}
  const previous = Array.isArray(originBucket[pathKey]?.assets) ? originBucket[pathKey].assets : []
  const merged = options.replace === true ? incoming : dedupeAssets([...previous, ...incoming])

  originBucket[pathKey] = {
    assets: merged,
    updatedAt: Date.now()
  }

  const paths = Object.keys(originBucket)
  if (paths.length > MAX_PATHS_PER_ORIGIN) {
    paths
      .sort((a, b) => (originBucket[b]?.updatedAt || 0) - (originBucket[a]?.updatedAt || 0))
      .slice(MAX_PATHS_PER_ORIGIN)
      .forEach((path) => {
        delete originBucket[path]
      })
  }

  store[originKey] = originBucket
  await writeStore(store)
  return merged
}

function scorePathMatch(requestPath, candidatePath) {
  if (requestPath === candidatePath) return 1000 + candidatePath.length
  if (candidatePath === "/") return 1
  const prefix = candidatePath.endsWith("/") ? candidatePath : `${candidatePath}/`
  if (requestPath.startsWith(prefix)) return candidatePath.length
  return -1
}

async function lookupAssetsForUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { assets: [], matchedPath: null, fallback: null }
    }
    const store = await readStore()
    const originBucket = store[parsed.origin]
    if (!originBucket) {
      return { assets: [], matchedPath: null, fallback: null }
    }

    const requestPath = normalizePathname(parsed.pathname)
    let bestPath = null
    let bestScore = -1
    let rootAssets = null

    for (const [path, record] of Object.entries(originBucket)) {
      if (!Array.isArray(record?.assets) || record.assets.length === 0) continue
      if (path === "/") rootAssets = record.assets
      const score = scorePathMatch(requestPath, path)
      if (score > bestScore) {
        bestScore = score
        bestPath = path
      }
    }

    if (bestScore > 0 && bestPath) {
      return {
        assets: dedupeAssets(originBucket[bestPath].assets),
        matchedPath: bestPath,
        fallback: bestPath === "/" ? null : "path"
      }
    }

    if (rootAssets?.length) {
      return {
        assets: dedupeAssets(rootAssets),
        matchedPath: "/",
        fallback: "origin-root"
      }
    }

    return { assets: [], matchedPath: null, fallback: null }
  } catch {
    return { assets: [], matchedPath: null, fallback: null }
  }
}

function sanitizeRecordedAssetsFromPage(assets) {
  const styles = []
  const scripts = []
  const preloads = []

  for (const item of assets || []) {
    const entry = normalizeAssetEntry(item)
    if (!entry) continue
    if (entry.as === "style") styles.push(entry)
    else scripts.push(entry)
  }

  return dedupeAssets([...preloads, ...styles, ...scripts.slice(0, MAX_SCRIPT_ASSETS)])
}

ns.normalizeAssetUrl = normalizeAssetUrl
ns.dedupeAssets = dedupeAssets
ns.recordLayoutAssets = recordLayoutAssets
ns.lookupAssetsForUrl = lookupAssetsForUrl
ns.sanitizeRecordedAssetsFromPage = sanitizeRecordedAssetsFromPage
ns.normalizePathname = normalizePathname
})()
