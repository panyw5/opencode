import { Icon } from "@opencode-ai/ui/icon"
import { Markdown } from "@opencode-ai/ui/markdown"
import { createEffect, createMemo, createSignal, Show, type JSX } from "solid-js"
import { pair } from "@/components/dialog-prompt-editor-input"
import { paint as defaultPaint } from "@/components/prompt-input/expand"
import { useLanguage } from "@/context/language"
import { monoFontFamily, useSettings } from "@/context/settings"

type MarkdownEditorMode = "source" | "preview"

export function MarkdownEditorField(props: {
  text: string
  editable?: boolean
  busy?: boolean
  preview?: boolean
  placeholder?: string
  class?: string
  paint?: (value: string) => string
  onInput: (value: string) => void
}): JSX.Element {
  const settings = useSettings()
  const language = useLanguage()
  const [mode, setMode] = createSignal<MarkdownEditorMode>("source")
  let box: HTMLTextAreaElement | undefined
  let back: HTMLDivElement | undefined
  const html = createMemo(() => (props.paint ?? defaultPaint)(props.text))
  const font = createMemo(() => monoFontFamily(settings.appearance.font()))
  const editable = createMemo(() => props.editable ?? true)
  const previewMode = createMemo(() => props.preview && mode() === "preview")

  const sync = () => {
    if (!box || !back) return
    back.scrollTop = box.scrollTop
    back.scrollLeft = box.scrollLeft
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
    props.onInput(next.text)
    requestAnimationFrame(() => {
      if (!box) return
      box.setSelectionRange(next.start, next.end)
      sync()
    })
  }

  createEffect(() => {
    props.text
    requestAnimationFrame(sync)
  })

  createEffect(() => {
    if (!props.preview && mode() !== "source") setMode("source")
  })

  return (
    <div
      class={`relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border-weak-base bg-background-base shadow-xs-border-base ${props.class ?? ""}`}
    >
      <Show when={props.preview}>
        <MarkdownEditorModeToggle mode={mode()} onMode={setMode} />
      </Show>
      <Show
        when={previewMode()}
        fallback={
          <div class="relative min-h-0 flex-1 overflow-hidden">
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
              onInput={(event) => props.onInput(event.currentTarget.value)}
              onScroll={sync}
              onKeyDown={onPairKeyDown}
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
  )
}

function MarkdownEditorModeToggle(props: {
  mode: MarkdownEditorMode
  onMode: (mode: MarkdownEditorMode) => void
}): JSX.Element {
  const language = useLanguage()

  return (
    <div class="config-editor-mode-toggle">
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
