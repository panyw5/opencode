import { createEffect, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { QUICK_ASSISTANT_SELECTION_EVENT } from "@/utils/selection-prompt"
import { selectionMarkdown } from "./session-selection-markdown"

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
  let frame = 0
  let dragging = false
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  const hide = () => {
    if (state.visible) console.debug("[session-selection] toolbar hidden")
    range = undefined
    setState({ visible: false, copied: false })
  }
  const update = () => {
    if (dragging || toolbar?.contains(document.activeElement)) return
    const selection = window.getSelection()
    const root = props.root()
    if (!root || !selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim())
      return hide()
    const next = selection.getRangeAt(0)
    if (!root.contains(next.startContainer) || !root.contains(next.endContainer)) return hide()
    const content = (node: Node) => {
      const element = node instanceof Element ? node : node.parentElement
      return (
        element?.closest(
          '[data-component="markdown"], [data-component="bash-output"], [data-component="tool-output"]',
        ) && !element.closest('button, input, textarea, [contenteditable="true"]')
      )
    }
    if (!content(next.startContainer) || !content(next.endContainer)) return hide()
    const bounds = root.getBoundingClientRect()
    const rects = Array.from(next.getClientRects()).filter(
      (rect) => rect.width && rect.height && rect.bottom > bounds.top && rect.top < bounds.bottom,
    )
    const rect = rects[0]
    if (!rect) return hide()
    range = next.cloneRange()
    if (!state.visible) console.debug(`[session-selection] toolbar shown length=${selection.toString().length}`)
    const width = toolbar?.offsetWidth || Math.min(440, window.innerWidth - 16)
    const height = toolbar?.offsetHeight || 40
    const top = Math.max(bounds.top, rect.top)
    const below = top - height - 8 < Math.max(8, bounds.top)
    setState({
      visible: true,
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
      top: below ? Math.min(rect.bottom + 8, window.innerHeight - height - 8) : top - 8,
      below,
    })
  }
  const schedule = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
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
      schedule()
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      hide()
      window.getSelection()?.removeAllRanges()
    }
    document.addEventListener("selectionchange", schedule)
    document.addEventListener("pointerdown", down)
    document.addEventListener("pointerup", up)
    document.addEventListener("pointercancel", up)
    document.addEventListener("keydown", key)
    document.addEventListener("scroll", schedule, true)
    window.addEventListener("resize", schedule)
    onCleanup(() => {
      document.removeEventListener("selectionchange", schedule)
      document.removeEventListener("pointerdown", down)
      document.removeEventListener("pointerup", up)
      document.removeEventListener("pointercancel", up)
      document.removeEventListener("keydown", key)
      document.removeEventListener("scroll", schedule, true)
      window.removeEventListener("resize", schedule)
      cancelAnimationFrame(frame)
      clearTimeout(copyTimer)
    })
  })
  createEffect(() => {
    if (!state.visible) return
    schedule()
    requestAnimationFrame(() => {
      if (!toolbar?.isConnected) return
      const style = getComputedStyle(toolbar)
      console.debug(`[session-selection] toolbar style background=${style.backgroundColor} z=${style.zIndex}`)
    })
  })

  return (
    <Show when={state.visible}>
      <Portal>
        <div
          ref={toolbar}
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
