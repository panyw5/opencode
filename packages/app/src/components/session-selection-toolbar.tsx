import { onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { QUICK_ASSISTANT_SELECTION_EVENT } from "@/utils/selection-prompt"
import { selectionMarkdown } from "./session-selection-markdown"
import { createSelectionFrameScheduler, readSessionSelection } from "./session-selection-state"

export function SessionSelectionToolbar(props: {
  root: Accessor<HTMLElement | undefined>
  onPrompt: (text: string) => void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const [state, setState] = createStore({ visible: false, left: 0, top: 0, below: false, copied: false })
  let toolbar: HTMLDivElement | undefined
  let range: Range | undefined
  let dragging = false
  let selectionLength = 0
  let trackedRoot: HTMLElement | undefined
  let releaseTracking: (() => void) | undefined
  let toolbarSize: { width: number; height: number } | undefined
  let toolbarObserver: ResizeObserver | undefined
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  const hideVisible = () => {
    if (state.visible) console.debug("[session-selection] toolbar hidden")
    if (toolbar) toolbarObserver?.unobserve(toolbar)
    toolbar = undefined
    toolbarSize = undefined
    setState({ visible: false, copied: false })
  }
  const hide = () => {
    scheduler.cancel()
    range = undefined
    selectionLength = 0
    releaseTracking?.()
    releaseTracking = undefined
    trackedRoot = undefined
    hideVisible()
  }
  const update = () => {
    if (dragging || toolbar?.contains(document.activeElement)) return
    const root = props.root()
    if (
      !root ||
      !range ||
      range.collapsed ||
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer)
    )
      return hide()
    const bounds = root.getBoundingClientRect()
    let rect: DOMRect | undefined
    for (const candidate of range.getClientRects()) {
      if (!candidate.width || !candidate.height || candidate.bottom <= bounds.top || candidate.top >= bounds.bottom)
        continue
      rect = candidate
      break
    }
    // Keep tracking an offscreen selection so scrolling it back reveals the toolbar.
    if (!rect) return hideVisible()
    if (!state.visible) console.debug(`[session-selection] toolbar shown length=${selectionLength}`)
    const width = toolbarSize?.width || Math.min(440, window.innerWidth - 16)
    const height = toolbarSize?.height || 40
    const top = Math.max(bounds.top, rect.top)
    const below = top - height - 8 < Math.max(8, bounds.top)
    setState({
      visible: true,
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
      top: below ? Math.min(rect.bottom + 8, window.innerHeight - height - 8) : top - 8,
      below,
    })
  }
  const scheduler = createSelectionFrameScheduler(update, {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (frame) => cancelAnimationFrame(frame),
  })
  const refreshSelection = () => {
    if (dragging || toolbar?.contains(document.activeElement)) return
    const root = props.root()
    const selected = readSessionSelection(window.getSelection(), root)
    if (!selected || !root) return hide()
    range = selected.range
    selectionLength = selected.length
    if (trackedRoot !== root) {
      releaseTracking?.()
      const schedule = () => scheduler.schedule()
      const observer = new ResizeObserver(schedule)
      observer.observe(root)
      root.addEventListener("scroll", schedule, true)
      window.addEventListener("resize", schedule)
      trackedRoot = root
      console.debug(`[session-selection] tracking enabled length=${selectionLength}`)
      releaseTracking = () => {
        observer.disconnect()
        root.removeEventListener("scroll", schedule, true)
        window.removeEventListener("resize", schedule)
        console.debug("[session-selection] tracking disabled")
      }
    }
    scheduler.schedule()
  }
  const bindToolbar = (node: HTMLDivElement) => {
    if (toolbar) toolbarObserver?.unobserve(toolbar)
    toolbar = node
    toolbarObserver ??= new ResizeObserver((entries) => {
      const entry = entries.find((entry) => entry.target === toolbar)
      if (!entry) return
      const box = entry.borderBoxSize[0]
      if (!box || !box.inlineSize || !box.blockSize) return
      if (toolbarSize?.width === box.inlineSize && toolbarSize.height === box.blockSize) return
      toolbarSize = { width: box.inlineSize, height: box.blockSize }
      scheduler.schedule()
    })
    toolbarObserver.observe(node)
  }
  const text = () => {
    if (!range || !props.root()?.contains(range.commonAncestorContainer)) return ""
    return selectionMarkdown(range) || range.toString().trim()
  }
  const send = (target: "prompt" | "assistant") => {
    const markdown = text()
    if (!markdown) return hide()
    console.debug(`[session-selection] send target=${target} length=${markdown.length}`)
    hide()
    window.getSelection()?.removeAllRanges()
    if (target === "prompt") props.onPrompt(markdown)
    else window.dispatchEvent(new CustomEvent(QUICK_ASSISTANT_SELECTION_EVENT, { detail: markdown }))
  }
  const copy = async () => {
    const markdown = text()
    if (!markdown) return hide()
    console.debug(`[session-selection] copy start length=${markdown.length}`)
    try {
      await navigator.clipboard.writeText(markdown)
      console.debug(`[session-selection] copy complete length=${markdown.length}`)
      setState("copied", true)
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => setState("copied", false), 2000)
    } catch (error) {
      console.error(`[session-selection] copy failed error=${String(error)}`)
      showToast({ title: language.t("common.requestFailed"), description: String(error) })
    }
  }
  onMount(() => {
    const down = (event: PointerEvent) => {
      if (toolbar?.contains(event.target as Node)) return
      dragging = true
      hide()
    }
    const up = () => {
      dragging = false
      refreshSelection()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      hide()
      window.getSelection()?.removeAllRanges()
    }
    document.addEventListener("selectionchange", refreshSelection)
    document.addEventListener("pointerdown", down)
    document.addEventListener("pointerup", up)
    document.addEventListener("pointercancel", up)
    document.addEventListener("keydown", key)
    refreshSelection()
    onCleanup(() => {
      document.removeEventListener("selectionchange", refreshSelection)
      document.removeEventListener("pointerdown", down)
      document.removeEventListener("pointerup", up)
      document.removeEventListener("pointercancel", up)
      document.removeEventListener("keydown", key)
      hide()
      toolbarObserver?.disconnect()
      clearTimeout(copyTimer)
    })
  })
  return (
    <Show when={state.visible}>
      <Portal>
        <div
          ref={bindToolbar}
          role="toolbar"
          aria-label={language.t("session.selection.toolbar")}
          data-component="session-selection-toolbar"
          class="fixed z-50 flex flex-wrap items-center gap-1 rounded-lg border border-border-base bg-background-base p-1 shadow-lg max-w-[calc(100vw-16px)]"
          style={{
            left: `${state.left}px`,
            top: `${state.top}px`,
            transform: state.below ? undefined : "translateY(-100%)",
            "background-color": "var(--surface-raised-stronger-non-alpha, var(--background-base))",
            isolation: "isolate",
          }}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
        >
          <Button size="small" variant="ghost" data-action="selection-copy-markdown" onClick={copy}>
            {language.t(state.copied ? "session.selection.copied" : "session.selection.copyMarkdown")}
          </Button>
          <Button size="small" variant="ghost" data-action="selection-to-prompt" onClick={() => send("prompt")}>
            {language.t("session.selection.toPrompt")}
          </Button>
          <Show when={platform.platform === "desktop"}>
            <Button
              size="small"
              variant="ghost"
              data-action="selection-to-assistant"
              disabled={settings.assistant.model() === "disabled"}
              onClick={() => send("assistant")}
            >
              {language.t("session.selection.toAssistant")}
            </Button>
          </Show>
        </div>
      </Portal>
    </Show>
  )
}
