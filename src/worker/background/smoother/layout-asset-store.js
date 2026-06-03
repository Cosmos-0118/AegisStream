(() => {
var ns = (self.AegisBackground ||= {})

const STORAGE_KEY = "layoutAssetsByOrigin"
const MAX_PATHS_PER_ORIGIN = 40
const MAX_ASSETS_PER_PATH = 12
const MAX_SCRIPT_ASSETS = 5

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

async function recordLayoutAssets(origin, pathname, assets) {
  if (!origin || !Array.isArray(assets) || assets.length === 0) return []
  const normalized = dedupeAssets(assets)
  if (normalized.length === 0) return []

  const store = await readStore()
  const originKey = origin
  const pathKey = normalizePathname(pathname)
  const originBucket = store[originKey] && typeof store[originKey] === "object" ? store[originKey] : {}

  originBucket[pathKey] = {
    assets: normalized,
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
  return normalized
}

function scorePathMatch(requestPath, candidatePath) {
  if (requestPath === candidatePath) return 1000
  if (candidatePath === "/") return 1
  if (requestPath.startsWith(candidatePath.endsWith("/") ? candidatePath : `${candidatePath}/`)) {
    return candidatePath.length
  }
  return -1
}

async function lookupAssetsForUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return []
    const store = await readStore()
    const originBucket = store[parsed.origin]
    if (!originBucket) return []

    const requestPath = normalizePathname(parsed.pathname)
    let best = null
    let bestScore = -1

    for (const [path, record] of Object.entries(originBucket)) {
      const score = scorePathMatch(requestPath, path)
      if (score > bestScore && Array.isArray(record?.assets) && record.assets.length > 0) {
        bestScore = score
        best = record.assets
      }
    }

    return dedupeAssets(best || [])
  } catch {
    return []
  }
}

function sanitizeRecordedAssetsFromPage(assets) {
  const styles = []
  const scripts = []
  for (const item of assets || []) {
    const entry = normalizeAssetEntry(item)
    if (!entry) continue
    if (entry.as === "style") styles.push(entry)
    else scripts.push(entry)
  }
  return [...styles, ...scripts.slice(0, MAX_SCRIPT_ASSETS)]
}

ns.normalizeAssetUrl = normalizeAssetUrl
ns.dedupeAssets = dedupeAssets
ns.recordLayoutAssets = recordLayoutAssets
ns.lookupAssetsForUrl = lookupAssetsForUrl
ns.sanitizeRecordedAssetsFromPage = sanitizeRecordedAssetsFromPage
})()
