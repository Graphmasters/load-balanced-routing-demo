/*
 * The colour theme is the reader's own choice if they made one, else the system's. The choice is kept in localStorage,
 * which a browser can block (private windows), so it is read and written with a fallback.
 */

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'route-sim-theme'
const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

function storedChoice(): Theme | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : undefined
  } catch {
    return undefined
  }
}

/** The theme in effect: the reader's choice, else the system's. */
export function currentTheme(): Theme {
  return storedChoice() ?? (systemDark.matches ? 'dark' : 'light')
}

/** Sets the theme on the page. The colours in the stylesheet follow this attribute. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

/** Keeps the reader's choice, which then overrides the system's theme. */
export function rememberTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Not kept: the page goes back to the system's theme on reload.
  }
}

/** Calls `listener` when the system's theme changes, unless the reader has made a choice of their own. */
export function onSystemThemeChange(listener: (theme: Theme) => void): void {
  systemDark.addEventListener('change', () => {
    if (storedChoice() === undefined) listener(currentTheme())
  })
}
