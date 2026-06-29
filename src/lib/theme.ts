const THEME_QUERY_KEY = 'theme'
const THEME_STORAGE_KEY = 'smallice-draw-theme'

type ThemePreference = 'light' | 'dark' | 'system'

let mediaQuery: MediaQueryList | null = null
let mediaQueryHandler: ((event: MediaQueryListEvent) => void) | null = null

export function applyInitialThemeFromUrl() {
  const url = new URL(window.location.href)
  const theme = normalizeTheme(url.searchParams.get(THEME_QUERY_KEY))
  applyTheme(theme)
  if (theme !== 'system') {
    writeStoredTheme(theme)
  }
}

function applyTheme(theme: ThemePreference) {
  detachSystemListener()

  if (theme === 'system') {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const syncSystemTheme = (matches: boolean) => setDocumentTheme(matches)
    syncSystemTheme(query.matches)
    mediaQuery = query
    mediaQueryHandler = (event) => syncSystemTheme(event.matches)
    query.addEventListener('change', mediaQueryHandler)
    return
  }

  setDocumentTheme(theme === 'dark')
}

function normalizeTheme(value: string | null): ThemePreference {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'dark' || normalized === 'light') return normalized
  if (normalized === 'auto' || normalized === 'system') return 'system'

  const stored = readStoredTheme()
  if (stored === 'dark' || stored === 'light') return stored
  return 'system'
}

function setDocumentTheme(isDark: boolean) {
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'
}

function detachSystemListener() {
  if (mediaQuery && mediaQueryHandler) {
    mediaQuery.removeEventListener('change', mediaQueryHandler)
  }
  mediaQuery = null
  mediaQueryHandler = null
}

function readStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStoredTheme(theme: ThemePreference) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // localStorage may be unavailable in private browsing; the current page still applies the URL theme.
  }
}
