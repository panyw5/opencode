import { TextField, type TextFieldProps } from "@opencode-ai/ui/text-field"
import { createEffect, onCleanup, Show, splitProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { hasProviderV1, pasteProviderBaseURL, stripProviderV1, usesProviderV1 } from "./provider-base-url"

export function ProviderBaseURLField(
  props: TextFieldProps & {
    value: string
    npm?: string
    autoV1: boolean
    onChange: (value: string) => void
    onAutoV1Change: (value: boolean) => void
  },
) {
  const language = useLanguage()
  const [local, rest] = splitProps(props, ["value", "npm", "autoV1", "onChange", "onAutoV1Change"])
  let suffix: HTMLButtonElement | undefined
  let animation: Animation | undefined
  onCleanup(() => animation?.cancel())
  createEffect(() => {
    console.info(
      `[provider-base-url] SDK=${local.npm?.trim() || "@ai-sdk/openai-compatible"} autoV1=${local.autoV1 && usesProviderV1(local.npm)}`,
    )
  })

  const change = (value: string) => {
    local.onChange(value)
    if (!local.autoV1 || !usesProviderV1(local.npm) || !hasProviderV1(value)) return
    animation?.cancel()
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    console.info(`[provider-base-url] typed v1 suffix detected warning=scale-bounce systemReducedMotion=${reduced}`)
    animation = suffix?.animate(
      [1, 1.28, 0.94, 1.03, 1].map((scale, index) => ({
        transform: `scale(${scale})`,
        offset: [0, 0.28, 0.56, 0.78, 1][index],
      })),
      { duration: 480, easing: "ease-out" },
    )
  }

  const toggleAutoV1 = () => {
    const next = !local.autoV1
    if (next) local.onChange(stripProviderV1(local.value, local.npm))
    local.onAutoV1Change(next)
    console.info(`[provider-base-url] autoV1 toggled enabled=${next}`)
  }

  return (
    <div data-component="provider-base-url">
      <TextField
        {...rest}
        value={local.value}
        onChange={change}
        suffix={
          <Show when={usesProviderV1(local.npm)}>
            <button
              type="button"
              ref={suffix}
              data-slot="provider-base-url-suffix"
              title={language.t("provider.custom.field.baseURL.autoV1")}
              aria-label={language.t("provider.custom.field.baseURL.autoV1")}
              aria-pressed={local.autoV1}
              onClick={toggleAutoV1}
            >
              /v1
            </button>
          </Show>
        }
        onPaste={(event: ClipboardEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
          if (!local.autoV1 || !usesProviderV1(local.npm)) return
          const pasted = event.clipboardData?.getData("text/plain")
          if (!pasted) return
          event.preventDefault()
          const input = event.currentTarget
          const result = pasteProviderBaseURL(
            input.value,
            pasted,
            input.selectionStart ?? input.value.length,
            input.selectionEnd ?? input.value.length,
            local.npm,
            local.autoV1,
          )
          console.info(`[provider-base-url] paste normalized removed=${hasProviderV1(pasted) ? "v1" : "none"}`)
          input.value = result.value
          local.onChange(result.value)
          input.setSelectionRange(result.caret, result.caret)
        }}
      />
    </div>
  )
}
