import { getActiveThemeId, listThemes, setTheme } from "./theme-engine.js"

/**
 * @param {HTMLElement} root
 */
export function mountThemeMenu(root) {
  if (!root) return

  const trigger = root.querySelector("#themeMenuTrigger")
  const panel = root.querySelector("#themeMenuPanel")
  const picker = root.querySelector("#themePicker")
  if (!trigger || !panel || !picker) return

  mountThemePicker(picker, root)

  trigger.addEventListener("click", (event) => {
    event.stopPropagation()
    togglePanel(trigger, panel)
  })

  document.addEventListener("click", (event) => {
    if (!root.contains(/** @type {Node} */ (event.target))) {
      closePanel(trigger, panel)
    }
  })

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePanel(trigger, panel)
    }
  })
}

/**
 * @param {HTMLElement} container
 * @param {HTMLElement} menuRoot
 */
function mountThemePicker(container, menuRoot) {
  container.innerHTML = ""
  container.setAttribute("role", "radiogroup")
  container.setAttribute("aria-label", "Appearance theme")

  for (const theme of listThemes()) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "theme-picker__option"
    btn.dataset.themeId = theme.id
    btn.setAttribute("role", "radio")
    btn.setAttribute("aria-checked", theme.id === getActiveThemeId() ? "true" : "false")
    btn.title = theme.description

    const swatch = document.createElement("span")
    swatch.className = "theme-picker__swatch"
    swatch.dataset.themePreview = theme.id
    swatch.setAttribute("aria-hidden", "true")

    const label = document.createElement("span")
    label.className = "theme-picker__label"
    label.textContent = theme.label

    btn.append(swatch, label)
    btn.addEventListener("click", () => {
      void selectTheme(theme.id, container, menuRoot)
    })
    container.appendChild(btn)
  }

  syncPickerState(container)
  document.addEventListener("aegisstream-theme-change", () => syncPickerState(container))
}

/**
 * @param {HTMLButtonElement} trigger
 * @param {HTMLElement} panel
 */
function togglePanel(trigger, panel) {
  const isOpen = !panel.hidden
  if (isOpen) {
    closePanel(trigger, panel)
    return
  }
  openPanel(trigger, panel)
}

/**
 * @param {HTMLButtonElement} trigger
 * @param {HTMLElement} panel
 */
function openPanel(trigger, panel) {
  panel.hidden = false
  trigger.setAttribute("aria-expanded", "true")
  trigger.classList.add("is-open")
}

/**
 * @param {HTMLButtonElement} trigger
 * @param {HTMLElement} panel
 */
function closePanel(trigger, panel) {
  panel.hidden = true
  trigger.setAttribute("aria-expanded", "false")
  trigger.classList.remove("is-open")
}

/**
 * @param {string} themeId
 * @param {HTMLElement} container
 * @param {HTMLElement} menuRoot
 */
async function selectTheme(themeId, container, menuRoot) {
  await setTheme(themeId)
  syncPickerState(container)
  const trigger = menuRoot.querySelector("#themeMenuTrigger")
  const panel = menuRoot.querySelector("#themeMenuPanel")
  if (trigger instanceof HTMLButtonElement && panel) {
    closePanel(trigger, panel)
  }
}

/**
 * @param {HTMLElement} container
 */
function syncPickerState(container) {
  const active = getActiveThemeId()
  for (const btn of container.querySelectorAll(".theme-picker__option")) {
    const isActive = btn.dataset.themeId === active
    btn.classList.toggle("is-active", isActive)
    btn.setAttribute("aria-checked", isActive ? "true" : "false")
  }
}
