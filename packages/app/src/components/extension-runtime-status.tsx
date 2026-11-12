import { Show, createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { ExtensionCard } from "./extension-card"
import { useLanguage } from "@/context/language"
import { ExtensionMutationStaleError } from "@/extensions/mutation"
import { extensionRuntimeRetryable, extensionRuntimeState } from "@/extensions/runtime-state"
import type { ExtensionInfo } from "@/extensions/types"

type Label =
  | "config.extensions.runtime.title"
  | "config.extensions.runtime.error"
  | "config.extensions.runtime.restart"
  | "config.extensions.runtime.retry"
  | "config.extensions.runtime.retrying"
  | "config.extensions.runtime.failed"
  | "config.extensions.toggle.syncFailed"

export function ExtensionRuntimeStatus(props: {
  item: ExtensionInfo
  retry: (id: string) => Promise<{ info: ExtensionInfo; synced: boolean }>
  connection: () => unknown
  disabled?: boolean
  language?: { t: (key: Label) => string }
  notify?: typeof showToast
}) {
  const language = props.language ?? useLanguage()
  const notify = props.notify ?? showToast
  const [state, setState] = createStore({ pending: false, syncFailed: false })
  let alive = true
  let attempt = 0
  createEffect(
    on(
      () => [props.item.id, props.connection()],
      () => {
        attempt++
        setState({ pending: false, syncFailed: false })
      },
    ),
  )
  onCleanup(() => {
    alive = false
    attempt++
  })
  const status = () => extensionRuntimeState(props.item)
  const retry = async () => {
    if (state.pending || props.disabled || !extensionRuntimeRetryable(props.item)) return
    const id = props.item.id
    const connection = props.connection()
    const token = ++attempt
    const current = () => alive && token === attempt && props.item.id === id && props.connection() === connection
    setState({ pending: true, syncFailed: false })
    try {
      const result = await props.retry(id)
      if (!current()) return
      setState("syncFailed", !result.synced)
    } catch (error) {
      if (!current() || error instanceof ExtensionMutationStaleError) return
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[extension-runtime] retry failed id=${id} error=${message}`)
      notify({ variant: "error", title: language.t("config.extensions.runtime.failed"), description: message })
    } finally {
      if (current()) setState("pending", false)
    }
  }
  return (
    <Show when={status() === "blocked" || props.item.server?.runtime === "error" || state.syncFailed}>
      <div data-extension-runtime={props.item.id} data-runtime={status()}>
        <ExtensionCard title={language.t("config.extensions.runtime.title")}>
          <p class="text-13-medium text-text-danger-base">
            {language.t(
              status() === "blocked" ? "config.extensions.runtime.restart" : "config.extensions.runtime.error",
            )}
          </p>
          <Show when={props.item.server?.error}>
            <p class="break-words text-12-regular text-text-weak">{props.item.server?.error}</p>
          </Show>
          <Show when={state.syncFailed}>
            <p class="text-12-regular text-text-weak">{language.t("config.extensions.toggle.syncFailed")}</p>
          </Show>
          <Show when={extensionRuntimeRetryable(props.item)}>
            <Button
              data-action="extension-runtime-retry"
              disabled={state.pending || props.disabled}
              onClick={() => void retry()}
            >
              {language.t(state.pending ? "config.extensions.runtime.retrying" : "config.extensions.runtime.retry")}
            </Button>
          </Show>
        </ExtensionCard>
      </div>
    </Show>
  )
}
