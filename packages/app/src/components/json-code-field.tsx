import { createEffect, createMemo, Show, type JSX } from "solid-js"
import { pair } from "@/components/dialog-prompt-editor-input"
import { indent } from "@/components/markdown-editor-indent"
import { monoFontFamily, useSettings } from "@/context/settings"
import { paintCode } from "@/utils/paint-code"

export function JsonCodeField(props: {
  label?: string
  hideLabel?: boolean
  value: string
  onChange: (value: string) => void
  placeholder?: string
  error?: string
  validationState?: "valid" | "invalid"
  class?: string
  /** Minimum height in CSS length; default ~4 mono lines. */
  minHeight?: string
}): JSX.Element {
  const settings = useSettings()
  let box: HTMLTextAreaElement | undefined
  let back: HTMLDivElement | undefined
  const html = createMemo(() => paintCode(props.value))
  const font = createMemo(() => monoFontFamily(settings.appearance.font()))
  const invalid = createMemo(() => props.validationState === "invalid" || !!props.error)
  const minHeight = () => props.minHeight ?? "6.5rem"

  const sync = () => {
    if (!box || !back) return
    back.scrollTop = box.scrollTop
    back.scrollLeft = box.scrollLeft
  }

  const applyEdit = (next: { text: string; start: number; end: number }) => {
    props.onChange(next.text)
    requestAnimationFrame(() => {
      if (!box) return
      box.setSelectionRange(next.start, next.end)
      sync()
    })
  }

  const onKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent> = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.isComposing || event.keyCode === 229) return

    if (event.key === "Tab") {
      const next = indent({
        text: props.value,
        start: event.currentTarget.selectionStart ?? 0,
        end: event.currentTarget.selectionEnd ?? 0,
        shiftKey: event.shiftKey,
      })
      event.preventDefault()
      if (next) applyEdit(next)
      return
    }

    const next = pair({
      text: props.value,
      start: event.currentTarget.selectionStart ?? 0,
      end: event.currentTarget.selectionEnd ?? 0,
      key: event.key,
    })
    if (!next) return
    event.preventDefault()
    applyEdit(next)
  }

  createEffect(() => {
    props.value
    requestAnimationFrame(sync)
  })

  return (
    <div data-component="json-code-field" class={`flex min-w-0 flex-col gap-1 ${props.class ?? ""}`}>
      <Show when={props.label}>
        <label classList={{ "sr-only": props.hideLabel }} class="text-12-medium text-text-weak">
          {props.label}
        </label>
      </Show>
      <div
        class="relative min-h-0 overflow-hidden rounded-lg border bg-background-base"
        classList={{
          "border-border-critical-base": invalid(),
          "border-border-weak-base": !invalid(),
        }}
        style={{ "min-height": minHeight() }}
      >
        <div
          ref={(el) => {
            back = el
          }}
          aria-hidden="true"
          class="config-scrollbar pointer-events-none absolute inset-0 overflow-auto px-2.5 py-2 text-12-mono leading-5 whitespace-pre-wrap break-words"
          style={{ "font-family": font() }}
        >
          <div class="min-h-full w-full" innerHTML={html()} />
        </div>
        <textarea
          ref={(el) => {
            box = el
          }}
          class="config-scrollbar absolute inset-0 size-full min-h-0 resize-none overflow-auto bg-transparent px-2.5 py-2 text-12-mono leading-5 focus:outline-none"
          style={{
            color: "transparent",
            "-webkit-text-fill-color": "transparent",
            "caret-color": "var(--text-strong)",
            "font-family": font(),
            "min-height": minHeight(),
          }}
          spellcheck={false}
          aria-invalid={invalid() ? "true" : undefined}
          aria-label={props.label}
          value={props.value}
          onInput={(event) => props.onChange(event.currentTarget.value)}
          onScroll={sync}
          onKeyDown={onKeyDown}
        />
        <Show when={props.placeholder && props.value.length === 0}>
          <div
            class="pointer-events-none absolute inset-x-0 top-0 px-2.5 py-2 text-12-mono leading-5 whitespace-pre-wrap text-text-weak"
            style={{ "font-family": font() }}
          >
            {props.placeholder}
          </div>
        </Show>
      </div>
      <Show when={props.error}>
        <div class="text-11-regular text-text-critical-base" data-slot="json-code-field-error">
          {props.error}
        </div>
      </Show>
    </div>
  )
}
