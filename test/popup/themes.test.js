/**
 * Run: node test/popup/themes.test.js
 */
import assert from "node:assert/strict"
import { TOKEN_KEYS, tokenToCssVar, validateTheme } from "../../src/popup/themes/token-schema.js"
import { DEFAULT_THEME_ID, THEMES, THEME_BY_ID } from "../../src/popup/themes/registry.js"

assert.equal(tokenToCssVar("background.primary"), "--background-primary")
assert.equal(tokenToCssVar("accent.primary-hover"), "--accent-primary-hover")
assert.ok(TOKEN_KEYS.length >= 100, "token schema should be comprehensive")

const ids = new Set()
for (const theme of THEMES) {
  assert.ok(!ids.has(theme.id), `duplicate theme id: ${theme.id}`)
  ids.add(theme.id)
  assert.equal(theme.mode, theme.mode === "light" ? "light" : "dark")
  assert.ok(theme.label.length > 0)
  assert.ok(theme.description.length > 0)
  assert.ok(validateTheme(theme), `theme missing tokens: ${theme.id}`)
  assert.ok(theme.fonts.sans?.family)
  assert.ok(theme.fonts.mono?.family)
}

assert.ok(THEME_BY_ID.has(DEFAULT_THEME_ID))
assert.equal(THEMES.length, 4)

console.log("themes.test.js: ok")
