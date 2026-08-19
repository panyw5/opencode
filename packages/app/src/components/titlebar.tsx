import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useTheme } from "@opencode-ai/ui/theme/context"

import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { dict as enDict } from "@/i18n/en"
import { SessionTabsBar } from "@/components/session/session-tabs-bar"
import {
  TITLEBAR_CONTROLS_GAP_PX,
  WINDOWS_CAPTION_FALLBACK_PX,
  titlebarControlsPadding,
  titlebarControlsWidth,
  windowControlsOverlay,
  type WindowControlsOverlayLike,
} from "./titlebar-controls"
import { applyPath, backPath, forwardPath } from "./titlebar-history"

type TauriDesktopWindow = {
  startDragging?: () => Promise<void>
  toggleMaximize?: () => Promise<void>
}

type TauriThemeWindow = {
  setTheme?: (theme?: "light" | "dark" | null) => Promise<void>
}

type TauriApi = {
  window?: {
    getCurrentWindow?: () => TauriDesktopWindow
  }
  webviewWindow?: {
    getCurrentWebviewWindow?: () => TauriThemeWindow
  }
}

const tauriApi = () => (window as unknown as { __TAURI__?: TauriApi }).__TAURI__
const currentDesktopWindow = () => tauriApi()?.window?.getCurrentWindow?.()
const currentThemeWindow = () => tauriApi()?.webviewWindow?.getCurrentWebviewWindow?.()

export function Titlebar() {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  type DictKey = keyof typeof enDict
  const kw = (...keys: DictKey[]) =>
    language.locale() === "en" ? undefined : keys.map((k) => enDict[k]).join(" ")
  const theme = useTheme()
  const navigate = useNavigate()
  const location = useLocation()

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const electronWindows = createMemo(() => windows() && !tauriApi())
  const zoom = () => platform.webviewZoom?.() ?? 1
  // Match native traffic lights / Windows caption overlay height when the webview is zoomed.
  const minHeight = () => (mac() || windows() ? `${40 / zoom()}px` : undefined)
  const [controlsPadding, setControlsPadding] = createSignal(
    electronWindows() ? titlebarControlsPadding(WINDOWS_CAPTION_FALLBACK_PX) : 0,
  )

  createEffect(() => {
    if (!electronWindows()) {
      setControlsPadding(0)
      return
    }

    const overlay = windowControlsOverlay(navigator as { windowControlsOverlay?: WindowControlsOverlayLike })
    const apply = () => {
      const viewport = window.innerWidth
      const rect = overlay?.getTitlebarAreaRect?.()
      const area = rect ? { x: rect.x, width: rect.width } : undefined
      const inset = titlebarControlsWidth(area, viewport)
      const padding = titlebarControlsPadding(inset)
      setControlsPadding(padding)
      console.debug(
        `[titlebar] controls-inset px=${padding} caption=${inset} gap=${TITLEBAR_CONTROLS_GAP_PX} viewport=${viewport} areaX=${area?.x ?? "none"} areaW=${area?.width ?? "none"} visible=${String(overlay?.visible ?? false)}`,
      )
    }

    apply()
    overlay?.addEventListener?.("geometrychange", apply)
    window.addEventListener("resize", apply)
    onCleanup(() => {
      overlay?.removeEventListener?.("geometrychange", apply)
      window.removeEventListener("resize", apply)
    })
  })

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      keywords: kw("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      keywords: kw("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  const getWin = () => {
    if (platform.platform !== "desktop") return
    return currentDesktopWindow()
  }

  createEffect(() => {
    if (platform.platform !== "desktop") return

    const scheme = theme.colorScheme()
    const value = scheme === "system" ? null : scheme

    const win = currentThemeWindow()
    if (!win?.setTheme) return

    void win.setTheme(value).catch(() => undefined)
  })

  const interactive = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false

    const selector =
      "button, a, input, textarea, select, option, [role='button'], [role='tab'], [role='menuitem'], [contenteditable='true'], [contenteditable='']"

    return !!target.closest(selector)
  }

  const drag = (e: MouseEvent) => {
    const blocked = interactive(e.target)
    if (platform.platform !== "desktop") return
    if (e.buttons !== 1) return
    if (blocked) return

    const win = getWin()
    if (!win?.startDragging) return

    e.preventDefault()
    void win.startDragging().catch(() => undefined)
  }

  const maximize = (e: MouseEvent) => {
    if (platform.platform !== "desktop") return
    if (interactive(e.target)) return
    if (e.target instanceof Element && e.target.closest("[data-tauri-decorum-tb]")) return

    const win = getWin()
    if (!win?.toggleMaximize) return

    e.preventDefault()
    void win.toggleMaximize().catch(() => undefined)
  }

  return (
    <header
      data-component="titlebar"
      data-controls-padding={controlsPadding() > 0 ? String(controlsPadding()) : undefined}
      class="h-10 min-w-0 shrink-0 bg-background-base relative overflow-hidden box-border"
      style={{
        "min-height": minHeight(),
        // Reserve the native Windows min/max/close cluster. Padding lives on
        // the header so tabs shrink instead of sliding under the overlay.
        "padding-right": controlsPadding() > 0 ? `${controlsPadding()}px` : undefined,
      }}
    >
      <div
        class="flex h-full min-w-0 w-full items-center overflow-hidden"
        data-tauri-drag-region
        onMouseDown={drag}
        onDblClick={maximize}
      >
        <div
          classList={{
            "flex items-center min-w-0 shrink-0": true,
            "pl-2": !mac(),
          }}
        >
          <Show when={mac()}>
            {/* Keep native macOS traffic lights clear even when the desktop window is narrow. */}
            <div class="h-full shrink-0" style={{ width: `${84 / zoom()}px` }} />
            <div class="xl:hidden w-10 shrink-0 flex items-center justify-center">
              <IconButton
                icon="menu"
                variant="ghost"
                class="titlebar-icon rounded-md"
                onClick={layout.mobileSidebar.toggle}
                aria-label={language.t("sidebar.menu.toggle")}
                aria-expanded={layout.mobileSidebar.opened()}
              />
            </div>
          </Show>
          <Show when={!mac()}>
            <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
              <IconButton
                icon="menu"
                variant="ghost"
                class="titlebar-icon rounded-md"
                onClick={layout.mobileSidebar.toggle}
                aria-label={language.t("sidebar.menu.toggle")}
                aria-expanded={layout.mobileSidebar.opened()}
              />
            </div>
          </Show>
          <div id="opencode-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
        </div>

        <SessionTabsBar />

        <div
          classList={{
            "flex items-center min-w-0 shrink-0 ml-auto justify-end": true,
            "pr-2": !windows(),
          }}
          data-tauri-drag-region
          onMouseDown={drag}
        >
          <div id="opencode-titlebar-center-project" class="hidden md:flex shrink-0" />
          <div id="opencode-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
          <Show when={windows()}>
            <div data-tauri-decorum-tb class="flex flex-row" />
          </Show>
        </div>
      </div>
    </header>
  )
}
