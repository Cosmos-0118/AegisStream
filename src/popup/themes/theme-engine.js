import { tokenToCssVar, validateTheme } from "./token-schema.js"
import { DEFAULT_THEME_ID, THEME_BY_ID, THEMES } from "./registry.js"

export const THEME_STORAGE_KEY = "aegisPopupThemeId"

let activeThemeId = DEFAULT_THEME_ID
let fontStyleEl = null

/** @returns {import('./token-schema.js').ThemeDefinition[]} */
export function listThemes() {
  return THEMES
}

/** @returns {string} */
export function getActiveThemeId() {
  return activeThemeId
}

/**
 * @param {string} themeId
 * @returns {import('./token-schema.js').ThemeDefinition}
 */
export function resolveTheme(themeId) {
  return THEME_BY_ID.get(themeId) || THEME_BY_ID.get(DEFAULT_THEME_ID)
}

/**
 * @param {import('./token-schema.js').ThemeDefinition} theme
 */
export function applyTheme(theme) {
  validateTheme(theme)
  const root = document.documentElement
  root.dataset.theme = theme.id
  root.classList.toggle("theme-mode-light", theme.mode === "light")
  root.classList.toggle("theme-mode-dark", theme.mode !== "light")

  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(tokenToCssVar(key), value)
  }

  applyThemeFonts(theme)
  activeThemeId = theme.id
  document.dispatchEvent(
    new CustomEvent("aegisstream-theme-change", { detail: { themeId: theme.id } })
  )
}

/**
 * @param {import('./token-schema.js').ThemeDefinition} theme
 */
function applyThemeFonts(theme) {
  const links = []
  if (theme.fonts.sans?.url) links.push(theme.fonts.sans.url)
  if (theme.fonts.mono?.url && theme.fonts.mono.url !== theme.fonts.sans?.url) {
    links.push(theme.fonts.mono.url)
  }

  const href = links.join("\n")
  if (!fontStyleEl) {
    fontStyleEl = document.getElementById("aegis-theme-fonts")
    if (!fontStyleEl) {
      fontStyleEl = document.createElement("style")
      fontStyleEl.id = "aegis-theme-fonts"
      document.head.appendChild(fontStyleEl)
    }
  }

  if (!href) {
    fontStyleEl.textContent = ""
    return
  }

  fontStyleEl.textContent = links
    .map((url) => `@import url('${url}');`)
    .join("\n")
}

/**
 * @param {string} themeId
 * @returns {Promise<import('./token-schema.js').ThemeDefinition>}
 */
export async function setTheme(themeId) {
  const theme = resolveTheme(themeId)
  applyTheme(theme)
  await chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme.id })
  return theme
}

/** @returns {Promise<string>} */
export async function initTheme() {
  let storedId = DEFAULT_THEME_ID
  try {
    const stored = await chrome.storage.local.get(THEME_STORAGE_KEY)
    if (stored[THEME_STORAGE_KEY] && THEME_BY_ID.has(stored[THEME_STORAGE_KEY])) {
      storedId = stored[THEME_STORAGE_KEY]
    }
  } catch {
    storedId = DEFAULT_THEME_ID
  }

  applyTheme(resolveTheme(storedId))
  return storedId
}
