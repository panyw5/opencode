import { TextField, type TextFieldProps } from "@opencode-ai/ui/text-field"
import { createEffect, onCleanup, Show, splitProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { hasProviderV1, pasteProviderBaseURL, usesProviderV1 } from "./provider-base-url"

export function ProviderBaseURLField(
  props: TextFieldProps & { value: string; npm?: string; onChange: (value: string) => void },
) {
  const language = useLanguage()
  const [local, rest] = splitProps(props, ["value", "npm", "onChange"])
  let suffix: HTMLSpanElement | undefined
  let animation: Animation | undefined
  onCleanup(() => animation?.cancel())
  createEffect(() => {
    console.info(
      `[provider-base-url] SDK=${local.npm?.trim() || "@ai-sdk/openai-compatible"} autoV1=${usesProviderV1(local.npm)}`,
    )
  })

  const change = (value: string) => {
    local.onChange(value)
    if (!usesProviderV1(local.npm) || !hasProviderV1(value)) return
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

  return (
    <div data-component="provider-base-url">
      <TextField
        {...rest}
        value={local.value}
        onChange={change}
        description={usesProviderV1(local.npm) ? language.t("provider.custom.field.baseURL.autoV1") : rest.description}
        suffix={
          <Show when={usesProviderV1(local.npm)}>
            <span
              ref={suffix}
              data-slot="provider-base-url-suffix"
              title={language.t("provider.custom.field.baseURL.autoV1")}
            >
              /v1
            </span>
          </Show>
        }
        onPaste={(event: ClipboardEvent & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
          if (!usesProviderV1(local.npm)) return
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
