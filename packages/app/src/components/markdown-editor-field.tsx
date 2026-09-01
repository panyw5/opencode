import { Icon } from "@opencode-ai/ui/icon"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { useFilteredList } from "@opencode-ai/ui/hooks"
import { Markdown } from "@opencode-ai/ui/markdown"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { at, mention, pair } from "@/components/dialog-prompt-editor-input"
import { indent } from "@/components/markdown-editor-indent"
import { paint as defaultPaint } from "@/components/prompt-input/expand"
import { type AtOption } from "@/components/prompt-input/slash-popover"
import { resolveAtMenuLeft } from "@/components/at-menu-position"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { monoFontFamily, useSettings } from "@/context/settings"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"

type MarkdownEditorMode = "source" | "preview"

export function MarkdownEditorField(props: {
  text: string
  editable?: boolean
  busy?: boolean
  preview?: boolean
  toolbarAbove?: boolean
  defaultMode?: MarkdownEditorMode
  placeholder?: string
  class?: string
  chrome?: boolean
  autofocus?: boolean
  paint?: (value: string) => string
  mentions?: boolean
  searchFilesAndDirectories?: (query: string) => Promise<string[]>
  onInput: (value: string) => void
  onKeyDown?: (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => void
}): JSX.Element {
  const settings = useSettings()
  const language = useLanguage()
  const platform = usePlatform()
  const fileSearch = props.searchFilesAndDirectories ?? (async () => [])
  const [mode, setMode] = createSignal<MarkdownEditorMode>(props.defaultMode ?? "source")
  const [popover, setPopover] = createSignal<"at" | null>(null)
  const [menu, setMenu] = createStore({ top: 12, left: 12, max: 320 })
  let box: HTMLTextAreaElement | undefined
  let back: HTMLDivElement | undefined
  let menuRef: HTMLDivElement | undefined
  const html = createMemo(() => (props.paint ?? defaultPaint)(props.text))
  const font = createMemo(() => monoFontFamily(settings.appearance.font()))
  const editable = createMemo(() => props.editable ?? true)
  const previewMode = createMemo(() => props.preview && mode() === "preview")
  const chrome = createMemo(() => props.chrome ?? true)

  const sync = () => {
    if (!box || !back) return
    back.scrollTop = box.scrollTop
    back.scrollLeft = box.scrollLeft
  }

  const atKey = (item: AtOption | undefined) => {
    if (!item) return ""
    if (item.type === "consult") return `consult:${item.id}`
    if (item.type === "agent") return `agent:${item.name}`
    return `file:${item.path}`
  }

  const handleAtSelect = (item: AtOption | undefined) => {
    if (!item || item.type !== "file" || !box) return
    const match = at(props.text, box.selectionStart ?? props.text.length)
    if (!match) return
    const next = mention(props.text, match.start, match.end, item.path)
    setPopover(null)
    applyEdit(next, "mention")
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
  } = useFilteredList<AtOption>({
    items: async (query) =>
      (await fileSearch(query)).map((path) => ({ type: "file" as const, path, display: path })),
    key: atKey,
    filterKeys: ["display"],
    onSelect: handleAtSelect,
  })
  const shown = createMemo(() => atFlat().slice(0, 6))

  const placeAtMenu = () => {
    if (!box) return
    const style = window.getComputedStyle(box)
    const mirror = document.createElement("div")
    mirror.style.cssText = [
      "position:absolute",
      "visibility:hidden",
      "pointer-events:none",
      "white-space:pre-wrap",
      "word-break:break-word",
      `font:${style.font}`,
      `font-family:${style.fontFamily}`,
      `line-height:${style.lineHeight}`,
      `letter-spacing:${style.letterSpacing}`,
      `padding:${style.padding}`,
      `border:${style.border}`,
      "box-sizing:border-box",
      `width:${box.clientWidth}px`,
    ].join(";")
    mirror.textContent = props.text.slice(0, box.selectionStart ?? 0) || " "
    const mark = document.createElement("span")
    mark.textContent = "\u200b"
    mirror.append(mark)
    box.parentElement?.append(mirror)
    const top = mark.offsetTop - box.scrollTop
    const left = mark.offsetLeft - box.scrollLeft
    mirror.remove()

    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 20
    const padX = Number.parseFloat(style.paddingLeft) || 0
    const padY = Number.parseFloat(style.paddingTop) || 0
    const menuH = menuRef?.offsetHeight ?? Math.min(320, Math.max(40, atFlat().length * 34 + 16))
    const below = box.clientHeight - (top + padY + line)
    const nextTop = below >= Math.min(menuH, 180) ? top + padY + line + 6 : Math.max(8, top + padY - menuH - 6)
    const menuW = Math.min(menuRef?.offsetWidth ?? 280, Math.max(120, box.clientWidth - 16))
    setMenu({
      top: nextTop,
      left: resolveAtMenuLeft({ anchorLeft: left + padX, boxWidth: box.clientWidth, menuWidth: menuW }),
      max: Math.max(120, Math.min(320, box.clientHeight - nextTop - 8)),
    })
  }

  const refreshAt = () => {
    if (!props.mentions || !box) return
    const match = at(props.text, box.selectionStart ?? 0)
    if (!match) {
      setPopover(null)
      return
    }
    atOnInput(match.query)
    setPopover("at")
    requestAnimationFrame(placeAtMenu)
  }

  const applyEdit = (next: { text: string; start: number; end: number }, reason: string) => {
    console.debug(
      `[markdown-editor-field] apply reason=${reason} start=${next.start} end=${next.end} length=${next.text.length}`,
    )
    props.onInput(next.text)
    requestAnimationFrame(() => {
      if (!box) return
      box.setSelectionRange(next.start, next.end)
      sync()
    })
  }

  const onIndentKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (!editable()) return
    if (event.key !== "Tab") return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.isComposing || event.keyCode === 229) return

    const start = event.currentTarget.selectionStart ?? 0
    const end = event.currentTarget.selectionEnd ?? 0
    console.debug(
      `[markdown-editor-field] tab key shift=${String(event.shiftKey)} start=${start} end=${end} length=${props.text.length}`,
    )

    const next = indent({
      text: props.text,
      start,
      end,
      shiftKey: event.shiftKey,
    })
    // Always prevent default so Tab never leaves the editor for focus navigation.
    event.preventDefault()
    if (!next) {
      console.debug("[markdown-editor-field] tab noop")
      return
    }
    applyEdit(next, event.shiftKey ? "outdent" : "indent")
  }

  const onPairKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (!editable()) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.isComposing || event.keyCode === 229) return

    const next = pair({
      text: props.text,
      start: event.currentTarget.selectionStart ?? 0,
      end: event.currentTarget.selectionEnd ?? 0,
      key: event.key,
    })
    if (!next) return
    event.preventDefault()
    applyEdit(next, "pair")
  }

  const onKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (popover()) {
      if (event.key === "Tab") {
        const item = atFlat().find((entry) => atKey(entry) === atActive()) ?? atFlat()[0]
        if (item) handleAtSelect(item)
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrl =
        event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.key === "n" || event.key === "p")
      if (nav || ctrl) {
        atOnKeyDown(event)
        event.preventDefault()
        return
      }
      if (event.key === "Escape") {
        setPopover(null)
        event.preventDefault()
        return
      }
    }
    onIndentKeyDown(event)
    if (event.defaultPrevented) return
    onPairKeyDown(event)
    if (event.defaultPrevented) return
    props.onKeyDown?.(event)
  }

  createEffect(() => {
    props.text
    requestAnimationFrame(sync)
  })

  createEffect(() => {
    if (popover() !== "at") return
    atFlat()
    requestAnimationFrame(placeAtMenu)
  })

  createEffect(() => {
    if (popover() !== "at" || !menuRef) return
    const key = atActive()
    if (!key) return
    requestAnimationFrame(() => menuRef?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" }))
  })

  onCleanup(() => setPopover(null))

  createEffect(() => {
    if (!props.preview && mode() !== "source") setMode("source")
  })

  return (
    <div
      data-component="markdown-editor-field"
      class={`flex h-full min-h-0 flex-col ${props.class ?? ""}`}
    >
      <Show when={props.preview && props.toolbarAbove}>
        <div class="mb-2 flex shrink-0 justify-end">
          <MarkdownEditorModeToggle mode={mode()} onMode={setMode} inline />
        </div>
      </Show>
      <div
        class={`relative flex min-h-0 flex-1 flex-col overflow-hidden ${
          chrome() ? "rounded-xl border border-border-weak-base bg-background-base shadow-xs-border-base" : ""
        }`}
      >
        <Show when={props.preview && !props.toolbarAbove}>
          <MarkdownEditorModeToggle mode={mode()} onMode={setMode} />
        </Show>
        <Show
          when={previewMode()}
          fallback={
            <div class="relative min-h-0 flex-1 overflow-hidden">
            <div
              ref={(el) => {
                menuRef = el
              }}
              class="absolute z-20 min-h-10 w-[min(560px,calc(100%-16px))] overflow-auto no-scrollbar rounded-[12px] border border-white/10 p-2 shadow-[var(--shadow-lg-border-base)]"
              classList={{ hidden: popover() !== "at" }}
              style={{
                top: `${menu.top}px`,
                left: `${menu.left}px`,
                "max-height": `${menu.max}px`,
                "background-color":
                  platform.platform === "desktop"
                    ? platform.os === "windows"
                      ? "light-dark(#ffffff, var(--surface-raised-stronger-non-alpha))"
                      : "light-dark(#ffffff, rgb(12 12 14 / 0.34))"
                    : "rgb(12 12 14 / 0.34)",
                "backdrop-filter":
                  platform.platform === "desktop" && platform.os === "windows" ? "none" : "blur(40px) saturate(150%)",
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <div classList={{ hidden: atFlat().length > 0 }} class="px-2 py-1 text-text-weak">
                {language.t("prompt.popover.emptyResults")}
              </div>
              <For each={shown()}>
                {(item) => {
                  if (item.type !== "file") return null
                  const key = atKey(item)
                  const dir = item.path.endsWith("/") ? item.path : getDirectory(item.path)
                  const file = item.path.endsWith("/") ? "" : getFilename(item.path)
                  return (
                    <button
                      type="button"
                      data-key={key}
                      class="flex w-full items-center gap-x-2 rounded-md px-2 py-0.5"
                      classList={{ "bg-surface-raised-base-active": atActive() === key }}
                      onClick={() => handleAtSelect(item)}
                      onMouseEnter={() => setAtActive(key)}
                    >
                      <FileIcon
                        node={{ path: item.path, type: item.path.endsWith("/") ? "directory" : "file" }}
                        class="size-4 shrink-0"
                      />
                      <div class="min-w-0 flex items-center text-14-regular">
                        <span class="min-w-0 truncate whitespace-nowrap text-text-weak">{dir}</span>
                        <span class="whitespace-nowrap text-text-strong">{file}</span>
                      </div>
                    </button>
                  )
                }}
              </For>
            </div>
            <div
              ref={(el) => {
                back = el
              }}
              aria-hidden="true"
              class="config-scrollbar pointer-events-none absolute inset-0 overflow-auto px-4 py-3 text-13-mono leading-6 whitespace-pre-wrap break-words"
              style={{ "font-family": font() }}
            >
              <div class="min-h-full w-full" innerHTML={html()} />
            </div>
            <Show when={props.busy}>
              <div class="pointer-events-none absolute left-4 top-3 z-10 text-12-regular text-text-weak">
                {language.t("config.editor.loadingFile")}
              </div>
            </Show>
            <textarea
              ref={(el) => {
                box = el
              }}
              autofocus={props.autofocus}
              class="config-scrollbar absolute inset-0 size-full min-h-0 resize-none overflow-auto bg-transparent px-4 py-3 text-13-mono leading-6 focus:outline-none"
              style={{
                color: "transparent",
                "-webkit-text-fill-color": "transparent",
                "caret-color": "var(--text-strong)",
                "font-family": font(),
              }}
              spellcheck={false}
              readOnly={!editable()}
              value={props.text}
              placeholder=""
              onInput={(event) => {
                props.onInput(event.currentTarget.value)
                refreshAt()
              }}
              onScroll={() => {
                sync()
                if (popover() === "at") requestAnimationFrame(placeAtMenu)
              }}
              onClick={refreshAt}
              onKeyUp={refreshAt}
              onKeyDown={onKeyDown}
              onBlur={() => window.setTimeout(() => setPopover(null), 120)}
              onFocus={refreshAt}
            />
            <Show when={props.placeholder && props.text.length === 0}>
              <div
                class="pointer-events-none absolute inset-x-0 top-0 px-4 py-3 text-13-mono leading-6 whitespace-pre-wrap text-text-weak"
                style={{ "font-family": font() }}
              >
                {props.placeholder}
              </div>
            </Show>
            </div>
          }
        >
          <div class="config-scrollbar min-h-0 flex-1 overflow-auto px-5 py-4">
            <Markdown text={props.text} math="full" highlight="defer" class="text-13-regular leading-6" />
          </div>
        </Show>
      </div>
    </div>
  )
}

function MarkdownEditorModeToggle(props: {
  mode: MarkdownEditorMode
  onMode: (mode: MarkdownEditorMode) => void
  inline?: boolean
}): JSX.Element {
  const language = useLanguage()

  return (
    <div
      class="config-editor-mode-toggle"
      style={props.inline ? { position: "static", "pointer-events": "auto" } : undefined}
    >
      <div role="group" class="config-editor-mode-toggle__group">
        <button
          type="button"
          class="config-editor-mode-toggle__button"
          data-active={props.mode === "source" ? "true" : undefined}
          onClick={() => props.onMode("source")}
        >
          <Icon name="edit" size="small" />
          {language.t("trellis.tasks.edit")}
        </button>
        <button
          type="button"
          class="config-editor-mode-toggle__button"
          data-active={props.mode === "preview" ? "true" : undefined}
          onClick={() => props.onMode("preview")}
        >
          <Icon name="eye" size="small" />
          {language.t("trellis.tasks.preview")}
        </button>
      </div>
    </div>
  )
}
