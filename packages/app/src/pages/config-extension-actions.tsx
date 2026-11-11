import { Show, createEffect, createSignal, on, onCleanup, type JSX } from "solid-js"
import { ExtensionCard } from "../components/extension-card"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useExtensionHost, ExtensionMutationStaleError } from "@/extensions/host"
import { useGlobalSDK } from "@/context/global-sdk"
import type { ExtensionInfo } from "@/extensions/types"
import { extensionToggleBlocked } from "./config-extension-actions-state"

type ToggleResult = { info: ExtensionInfo; synced: boolean }
type ActionLabel =
  | "common.cancel"
  | `config.extensions.state.${ExtensionInfo["state"]}`
  | "config.extensions.toggle.enable"
  | "config.extensions.toggle.disable"
  | "config.extensions.toggle.busy"
  | "config.extensions.toggle.confirmDisable"
  | "config.extensions.toggle.confirmDescription"
  | "config.extensions.toggle.saveFirst"
  | "config.extensions.toggle.incompatible"
  | "config.extensions.toggle.enabled"
  | "config.extensions.toggle.disabled"
  | "config.extensions.toggle.failed"
  | "config.extensions.toggle.syncFailed"
  | "config.extensions.toggle.unavailable"
  | "config.extensions.toggle.refresh"

export function ConfigExtensionActions(props: {
  item: ExtensionInfo
  children?: JSX.Element
  dirty?: boolean
  saving?: boolean
  enabled?: boolean
  busy?: boolean
  setEnabled?: (id: string, enabled: boolean) => Promise<ToggleResult>
  language?: { t: (key: ActionLabel) => string }
  notify?: typeof showToast
  connection?: () => unknown
}) {
  const language = props.language ?? useLanguage()
  const notify = props.notify ?? showToast
  const host = props.setEnabled ? undefined : useExtensionHost()
  const sdk = props.setEnabled ? undefined : useGlobalSDK()
  const connection = props.connection ?? (() => sdk?.client)
  const [confirming, setConfirming] = createSignal(false)
  const [pending, setPending] = createSignal(false)
  const [syncFailed, setSyncFailed] = createSignal(false)
  let alive = true
  onCleanup(() => {
    alive = false
  })
  const enabled = () => props.enabled ?? host?.enabled() ?? true
  const busy = () => pending() || props.busy || host?.mutating(props.item.id) || false
  const blocked = () =>
    extensionToggleBlocked({
      item: props.item,
      enabled: enabled(),
      busy: busy(),
      dirty: !!props.dirty,
      saving: !!props.saving,
    })
  createEffect(
    on(
      () => [props.item.id, props.item.enabled, enabled(), props.dirty, props.saving, connection()],
      () => {
        setConfirming(false)
        setSyncFailed(false)
      },
    ),
  )

  const toggle = async () => {
    if (blocked()) return
    const source = connection()
    const id = props.item.id
    const next = !props.item.enabled
    setConfirming(false)
    setPending(true)
    try {
      const result = await (props.setEnabled ?? ((target, value) => host!.setEnabled(target, value)))(id, next)
      if (!alive || props.item.id !== id || connection() !== source) return
      setSyncFailed(!result.synced)
      const unavailable = next && result.info.state !== "ready"
      notify({
        variant: unavailable || !result.synced ? "error" : "success",
        title: language.t(
          !result.synced
            ? "config.extensions.toggle.syncFailed"
            : unavailable
              ? "config.extensions.toggle.unavailable"
              : next
                ? "config.extensions.toggle.enabled"
                : "config.extensions.toggle.disabled",
        ),
        description: result.info.displayName,
      })
    } catch (error) {
      if (error instanceof ExtensionMutationStaleError) return
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[config-extension-actions] toggle failed id=${id} error=${message}`)
      if (alive && props.item.id === id && connection() === source)
        notify({ title: language.t("config.extensions.toggle.failed"), description: message })
    } finally {
      if (alive) setPending(false)
    }
  }

  return (
    <div data-extension-actions={props.item.id}>
      <ExtensionCard>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="break-words text-20-medium text-text-strong">{props.item.displayName}</h2>
            <p class="break-all text-12-regular text-text-weak">
              {props.item.id} · v{props.item.version} · {language.t(`config.extensions.state.${props.item.state}`)}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={enabled()}>
              <Button
                data-action="extension-toggle"
                disabled={!!blocked()}
                onClick={() => {
                  if (blocked()) return
                  if (props.item.enabled) setConfirming(true)
                  else void toggle()
                }}
              >
                {language.t(
                  busy()
                    ? "config.extensions.toggle.busy"
                    : props.item.enabled
                      ? "config.extensions.toggle.disable"
                      : "config.extensions.toggle.enable",
                )}
              </Button>
            </Show>
            {props.children}
          </div>
        </div>
        <Show when={props.dirty || props.saving}>
          <p class="text-12-regular text-text-weak">{language.t("config.extensions.toggle.saveFirst")}</p>
        </Show>
        <Show when={props.item.state === "incompatible"}>
          <p class="text-12-regular text-text-weak">{language.t("config.extensions.toggle.incompatible")}</p>
        </Show>
        <Show when={props.item.error}>
          <p class="text-12-regular text-text-danger-base">{props.item.error}</p>
        </Show>
        <Show when={confirming()}>
          <div class="rounded-lg border border-border-weak-base bg-surface-base p-4">
            <p class="mb-3 text-13-regular text-text-weak">
              {language.t("config.extensions.toggle.confirmDescription")}
            </p>
            <div class="flex justify-end gap-2">
              <Button data-action="extension-toggle-cancel" onClick={() => setConfirming(false)}>
                {language.t("common.cancel")}
              </Button>
              <Button data-action="extension-toggle-confirm" disabled={!!blocked()} onClick={() => void toggle()}>
                {language.t("config.extensions.toggle.confirmDisable")}
              </Button>
            </div>
          </div>
        </Show>
        <Show when={syncFailed() && host}>
          <Button
            data-action="extension-toggle-refresh"
            disabled={busy()}
            onClick={() => {
              const source = connection()
              setPending(true)
              void host!
                .refresh({ strict: true })
                .then(() => {
                  if (alive && connection() === source) setSyncFailed(false)
                })
                .catch((error) => {
                  if (!alive || connection() !== source || error instanceof ExtensionMutationStaleError) return
                  notify({ title: language.t("config.extensions.toggle.syncFailed"), description: String(error) })
                })
                .finally(() => {
                  if (alive) setPending(false)
                })
            }}
          >
            {language.t("config.extensions.toggle.refresh")}
          </Button>
        </Show>
      </ExtensionCard>
    </div>
  )
}
