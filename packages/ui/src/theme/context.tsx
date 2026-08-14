import { createEffect, onCleanup, onMount, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "../context/helper"
import oc2ThemeJson from "./themes/oc-2.json"
import { resolveThemeVariant, themeToCss } from "./resolve"
import type { DesktopTheme } from "./types"

export type ColorScheme = "light" | "dark" | "system"

const STORAGE_KEYS = {
  THEME_ID: "opencode-theme-id",
  COLOR_SCHEME: "opencode-color-scheme",
  THEME_CSS_LIGHT: "opencode-theme-css-light",
  THEME_CSS_DARK: "opencode-theme-css-dark",
} as const

const THEME_STYLE_ID = "oc-theme"
let files: Record<string, () => Promise<{ default: DesktopTheme }>> | undefined
let ids: string[] | undefined
let known: Set<string> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob<{ default: DesktopTheme }>("./themes/*.json")
  return files
}

function themeIDs() {
  if (ids) return ids
  ids = Object.keys(getFiles())
    .map((path) => path.slice("./themes/".length, -".json".length))
    .sort()
  return ids
}

function knownThemes() {
  if (known) return known
  known = new Set(themeIDs())
  return known
}

const names: Record<string, string> = {
  "oc-2": "OC-2",
  aether: "Aether",
  amoled: "AMOLED",
  arc: "Arc",
  aura: "Aura",
  ayu: "Ayu",
  carbonfox: "Carbonfox",
  catppuccin: "Catppuccin",
  "catppuccin-frappe": "Catppuccin Frappe",
  "catppuccin-macchiato": "Catppuccin Macchiato",
  chatgpt: "ChatGPT",
  claude: "Claude",
  cobalt2: "Cobalt2",
  cursor: "Cursor",
  dracula: "Dracula",
  everforest: "Everforest",
  flexoki: "Flexoki",
  github: "GitHub",
  gruvbox: "Gruvbox",
  kanagawa: "Kanagawa",
  "lucent-orng": "Lucent Orng",
  material: "Material",
  matrix: "Matrix",
  mercury: "Mercury",
  monokai: "Monokai",
  nightowl: "Night Owl",
  nord: "Nord",
  "one-dark": "One Dark",
  onedarkpro: "One Dark Pro",
  opencode: "OpenCode",
  orng: "Orng",
  "osaka-jade": "Osaka Jade",
  palenight: "Palenight",
  rosepine: "Rose Pine",
  shadesofpurple: "Shades of Purple",
  solarized: "Solarized",
  synthwave84: "Synthwave '84",
  tokyonight: "Tokyonight",
  vercel: "Vercel",
  vesper: "Vesper",
  zenburn: "Zenburn",
}
const oc2Theme = oc2ThemeJson as DesktopTheme

function normalize(id: string | null | undefined) {
  return id === "oc-1" ? "oc-2" : id
}

function read(key: string) {
  if (typeof localStorage !== "object") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function drop(key: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(key)
  } catch {}
}

function clear() {
  drop(STORAGE_KEYS.THEME_CSS_LIGHT)
  drop(STORAGE_KEYS.THEME_CSS_DARK)
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) return existing
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  if (typeof window !== "object") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

let appliedKey = ""

function applyThemeCss(theme: DesktopTheme, themeId: string, mode: "light" | "dark") {
  const key = themeId + ":" + mode
  if (appliedKey === key && document.getElementById(THEME_STYLE_ID)?.textContent) return

  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)

  if (themeId !== "oc-2") {
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, css)
  }

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
}`

  document.getElementById("oc-theme-preload")?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  appliedKey = key
}

function cacheThemeVariants(theme: DesktopTheme, themeId: string) {
  if (themeId === "oc-2") return
  for (const mode of ["light", "dark"] as const) {
    const isDark = mode === "dark"
    const variant = isDark ? theme.dark : theme.light
    const tokens = resolveThemeVariant(variant, isDark)
    const css = themeToCss(tokens)
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, css)
  }
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { defaultTheme?: string; onThemeApplied?: (theme: DesktopTheme, mode: "light" | "dark") => void }) => {
    const themeId = normalize(read(STORAGE_KEYS.THEME_ID) ?? props.defaultTheme) ?? "oc-2"
    const colorScheme = (read(STORAGE_KEYS.COLOR_SCHEME) as ColorScheme | null) ?? "system"
    const mode = colorScheme === "system" ? getSystemMode() : colorScheme
    const [store, setStore] = createStore({
      themes: {
        "oc-2": oc2Theme,
      } as Record<string, DesktopTheme>,
      themeId,
      colorScheme,
      mode,
      previewThemeId: null as string | null,
      previewScheme: null as ColorScheme | null,
    })

    const setMode = (next: "light" | "dark") => {
      if (store.mode === next) return
      setStore("mode", next)
    }

    const setThemeId = (next: string) => {
      if (store.themeId === next) return
      setStore("themeId", next)
    }

    const loads = new Map<string, Promise<DesktopTheme | undefined>>()
    let previewEpoch = 0

    const load = (id: string) => {
      const next = normalize(id)
      if (!next) return Promise.resolve(undefined)
      const hit = store.themes[next]
      if (hit) return Promise.resolve(hit)
      const pending = loads.get(next)
      if (pending) return pending
      const file = getFiles()[`./themes/${next}.json`]
      if (!file) return Promise.resolve(undefined)
      const task = file()
        .then((mod) => {
          const theme = mod.default
          setStore("themes", next, theme)
          return theme
        })
        .finally(() => {
          loads.delete(next)
        })
      loads.set(next, task)
      return task
    }

    const applyTheme = (theme: DesktopTheme, themeId: string, mode: "light" | "dark") => {
      applyThemeCss(theme, themeId, mode)
      props.onThemeApplied?.(theme, mode)
    }

    const ids = () => {
      const extra = Object.keys(store.themes)
        .filter((id) => !knownThemes().has(id))
        .sort()
      const all = themeIDs()
      if (extra.length === 0) return all
      return [...all, ...extra]
    }

    const loadThemes = () => Promise.all(themeIDs().map(load)).then(() => store.themes)

    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.THEME_ID && e.newValue) {
        const next = normalize(e.newValue)
        if (!next) return
        if (next !== "oc-2" && !knownThemes().has(next) && !store.themes[next]) return
        setThemeId(next)
        if (next === "oc-2") {
          clear()
          return
        }
        void load(next).then((theme) => {
          if (!theme || store.themeId !== next) return
          cacheThemeVariants(theme, next)
        })
      }
      if (e.key === STORAGE_KEYS.COLOR_SCHEME && e.newValue) {
        const nextMode = e.newValue === "system" ? getSystemMode() : (e.newValue as "light" | "dark")
        setStore("colorScheme", e.newValue as ColorScheme)
        setMode(nextMode)
      }
    }

    if (typeof window === "object") {
      window.addEventListener("storage", onStorage)
      onCleanup(() => window.removeEventListener("storage", onStorage))
    }

    onMount(() => {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const onMedia = () => {
        if (store.colorScheme !== "system") return
        setMode(getSystemMode())
      }
      mediaQuery.addEventListener("change", onMedia)
      onCleanup(() => mediaQuery.removeEventListener("change", onMedia))

      const rawTheme = read(STORAGE_KEYS.THEME_ID)
      const savedTheme = normalize(rawTheme ?? props.defaultTheme) ?? "oc-2"
      const savedScheme = (read(STORAGE_KEYS.COLOR_SCHEME) as ColorScheme | null) ?? "system"
      if (rawTheme && rawTheme !== savedTheme) {
        write(STORAGE_KEYS.THEME_ID, savedTheme)
        clear()
      }
      if (savedTheme !== store.themeId) setThemeId(savedTheme)
      if (savedScheme !== store.colorScheme) setStore("colorScheme", savedScheme)
      setMode(savedScheme === "system" ? getSystemMode() : savedScheme)
      void load(savedTheme).then((theme) => {
        if (!theme || store.themeId !== savedTheme) return
        cacheThemeVariants(theme, savedTheme)
      })
    })

    createEffect(() => {
      const themeId = store.themeId
      const mode = store.mode
      const theme = store.themes[themeId]
      // Intentionally do NOT track preview* here. Clearing preview must not flash the
      // committed theme before the next preview/restore owns the DOM.
      if (!theme) return
      const previewing = untrack(() => !!(store.previewThemeId || store.previewScheme))
      if (previewing) return
      applyTheme(theme, themeId, mode)
    })

    const clearPreviewState = () => {
      previewEpoch += 1
      if (store.previewThemeId !== null) setStore("previewThemeId", null)
      if (store.previewScheme !== null) setStore("previewScheme", null)
    }

    const beginPreview = () => {
      previewEpoch += 1
      return previewEpoch
    }

    const setTheme = (id: string) => {
      const next = normalize(id)
      if (!next) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      if (next !== "oc-2" && !knownThemes().has(next) && !store.themes[next]) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      // Committing a selection must drop live preview without restoring the old theme.
      clearPreviewState()
      if (store.themeId === next) {
        void load(next).then((theme) => {
          if (!theme || store.themeId !== next) return
          applyTheme(theme, next, store.mode)
        })
        return
      }
      setThemeId(next)
      if (next === "oc-2") {
        write(STORAGE_KEYS.THEME_ID, next)
        clear()
        return
      }
      void load(next).then((theme) => {
        if (!theme || store.themeId !== next) return
        cacheThemeVariants(theme, next)
        write(STORAGE_KEYS.THEME_ID, next)
      })
    }

    const setColorScheme = (scheme: ColorScheme) => {
      const nextMode = scheme === "system" ? getSystemMode() : scheme
      clearPreviewState()
      if (store.colorScheme === scheme && store.mode === nextMode) {
        void load(store.themeId).then((theme) => {
          if (!theme) return
          applyTheme(theme, store.themeId, nextMode)
        })
        return
      }
      setStore("colorScheme", scheme)
      write(STORAGE_KEYS.COLOR_SCHEME, scheme)
      setMode(nextMode)
    }

    return {
      themeId: () => store.themeId,
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      ids,
      name: (id: string) => store.themes[id]?.name ?? names[id] ?? id,
      loadThemes,
      themes: () => store.themes,
      setTheme,
      setColorScheme,
      registerTheme: (theme: DesktopTheme) => setStore("themes", theme.id, theme),
      previewTheme: (id: string) => {
        const next = normalize(id)
        if (!next) return
        if (next !== "oc-2" && !knownThemes().has(next) && !store.themes[next]) return
        const epoch = beginPreview()
        // Theme browse uses the committed mode. Drop scheme preview without restoring DOM.
        if (store.previewScheme !== null) setStore("previewScheme", null)
        setStore("previewThemeId", next)
        void load(next).then((theme) => {
          if (!theme || store.previewThemeId !== next || epoch !== previewEpoch) return
          applyTheme(theme, next, store.mode)
        })
      },
      previewColorScheme: (scheme: ColorScheme) => {
        const mode = scheme === "system" ? getSystemMode() : scheme
        const epoch = beginPreview()
        // Scheme browse uses the committed theme. Drop theme preview without restoring DOM.
        if (store.previewThemeId !== null) setStore("previewThemeId", null)
        setStore("previewScheme", scheme)
        const id = store.themeId
        void load(id).then((theme) => {
          if (!theme) return
          if (store.previewThemeId) return
          if (store.previewScheme !== scheme || epoch !== previewEpoch) return
          applyTheme(theme, id, mode)
        })
      },
      commitPreview: () => {
        const themeId = store.previewThemeId
        const scheme = store.previewScheme
        clearPreviewState()
        if (themeId) setTheme(themeId)
        if (scheme) setColorScheme(scheme)
      },
      cancelPreview: () => {
        if (!store.previewThemeId && !store.previewScheme) return
        clearPreviewState()
        const epoch = previewEpoch
        // Defer restore so a same-tick / next-tick preview can supersede and avoid flicker.
        queueMicrotask(() => {
          if (epoch !== previewEpoch) return
          if (store.previewThemeId || store.previewScheme) return
          void load(store.themeId).then((theme) => {
            if (!theme || epoch !== previewEpoch) return
            if (store.previewThemeId || store.previewScheme) return
            applyTheme(theme, store.themeId, store.mode)
          })
        })
      },
    }
  },
})
