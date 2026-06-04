import { obsidianTheme } from "./configs/obsidian.js"
import { auroraTheme } from "./configs/aurora.js"
import { paperTheme } from "./configs/paper.js"
import { emberTheme } from "./configs/ember.js"

export const DEFAULT_THEME_ID = "obsidian"

/** @type {import('./token-schema.js').ThemeDefinition[]} */
export const THEMES = [obsidianTheme, auroraTheme, paperTheme, emberTheme]

/** @type {Map<string, import('./token-schema.js').ThemeDefinition>} */
export const THEME_BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]))
