/**
 * Semantic design token schema for the popup UI.
 * Components consume CSS variables: background.primary → --background-primary
 */

/** @typedef {'dark' | 'light'} ThemeMode */

/**
 * @typedef {Object} ThemeFontSpec
 * @property {string} family
 * @property {string} weights
 * @property {string} url
 */

/**
 * @typedef {Object} ThemeDefinition
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {ThemeMode} mode
 * @property {{ sans: ThemeFontSpec, mono: ThemeFontSpec }} fonts
 * @property {Record<string, string>} tokens
 */

export const TOKEN_KEYS = [
  "background.primary",
  "background.secondary",
  "background.gradient-a",
  "background.gradient-b",
  "surface.default",
  "surface.raised",
  "surface.sunken",
  "surface.overlay",
  "text.primary",
  "text.secondary",
  "text.tertiary",
  "text.inverse",
  "text.link",
  "border.default",
  "border.subtle",
  "border.strong",
  "border.focus",
  "accent.primary",
  "accent.primary-hover",
  "accent.secondary",
  "accent.glow",
  "accent.gradient-start",
  "accent.gradient-end",
  "status.success",
  "status.success-foreground",
  "status.success-muted-bg",
  "status.success-muted-border",
  "status.warning",
  "status.warning-foreground",
  "status.warning-muted-bg",
  "status.warning-muted-border",
  "status.danger",
  "status.danger-foreground",
  "status.danger-muted-bg",
  "status.danger-muted-border",
  "status.info",
  "status.info-muted-bg",
  "status.info-muted-border",
  "icon.logo-gradient-start",
  "icon.logo-gradient-end",
  "shadow.card",
  "shadow.button",
  "shadow.glow-accent",
  "radius.lg",
  "radius.md",
  "radius.sm",
  "radius.pill",
  "space.xs",
  "space.sm",
  "space.md",
  "space.lg",
  "space.xl",
  "font.family.sans",
  "font.family.mono",
  "font.size-xs",
  "font.size-sm",
  "font.size-md",
  "font.size-lg",
  "font.size-xl",
  "font.weight-regular",
  "font.weight-medium",
  "font.weight-semibold",
  "font.weight-bold",
  "motion.duration-fast",
  "motion.duration-normal",
  "motion.easing-default",
  "chart.progress-track",
  "chart.progress-track-border",
  "chart.progress-fill-start",
  "chart.progress-fill-end",
  "chart.progress-glow",
  "input.background",
  "input.border",
  "input.focus-background",
  "input.focus-ring",
  "switch.track",
  "switch.thumb",
  "switch.track-active",
  "scrollbar.thumb",
  "nav.tab-inactive",
  "nav.tab-active",
  "nav.tab-indicator-glow",
  "button.primary-bg",
  "button.primary-fg",
  "button.primary-hover",
  "button.secondary-bg",
  "button.secondary-fg",
  "button.secondary-border",
  "button.secondary-hover-bg",
  "button.secondary-hover-fg",
  "button.secondary-hover-border",
  "button.disabled-opacity",
  "metric.surface",
  "metric.surface-hover",
  "metric.label",
  "metric.value",
  "badge.experimental-text",
  "badge.experimental-bg-start",
  "badge.experimental-bg-end",
  "badge.experimental-border",
  "badge.experimental-dot",
  "badge.experimental-row-bg-start",
  "badge.experimental-row-border",
  "scope.badge-text",
  "scope.badge-bg",
  "scope.badge-border",
  "speculative.accent-border",
  "speculative.mode-text",
  "speculative.mode-bg",
  "speculative.mode-border",
  "pipeline.background",
  "pipeline.border",
  "pipeline.active-background",
  "pipeline.active-border",
  "pipeline.active-text",
  "log.background",
  "log.entry-background",
  "log.msg",
  "log.level-info",
  "log.level-warn",
  "log.level-error",
  "log.error-entry-bg",
  "header.status-bg",
  "header.status-border",
  "header.title-tracking",
  "setting.row-divider",
  "setting.nested-border",
  "setting.code-bg",
  "density.popup-width",
  "density.popup-height",
  "density.content-padding-x",
  "density.content-padding-y"
]

const TOKEN_KEY_SET = new Set(TOKEN_KEYS)

/** @param {string} tokenKey */
export function tokenToCssVar(tokenKey) {
  return `--${tokenKey.replace(/\./g, "-")}`
}

/**
 * @param {ThemeDefinition} theme
 * @returns {string[]}
 */
export function findMissingTokens(theme) {
  return TOKEN_KEYS.filter((key) => theme.tokens[key] == null || theme.tokens[key] === "")
}

/**
 * @param {ThemeDefinition} theme
 * @returns {boolean}
 */
export function validateTheme(theme) {
  const missing = findMissingTokens(theme)
  if (missing.length) {
    console.warn(`[theme] "${theme.id}" missing tokens:`, missing)
    return false
  }
  return true
}

/**
 * @param {Omit<ThemeDefinition, 'tokens'> & { tokens: Record<string, string> }} definition
 * @returns {ThemeDefinition}
 */
export function defineTheme(definition) {
  const unknown = Object.keys(definition.tokens).filter((k) => !TOKEN_KEY_SET.has(k))
  if (unknown.length) {
    console.warn(`[theme] "${definition.id}" unknown tokens:`, unknown)
  }
  return /** @type {ThemeDefinition} */ (definition)
}
