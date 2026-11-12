import { ProviderChip, type ProviderChipProps } from "@/components/provider-chip"
import { createMemo, Show, type JSX } from "solid-js"
import type { ConfigProviderItem } from "./config-provider-list"
import "./config-provider-list.css"

export const CONFIG_MIDDLE_ITEM_CLASS =
  "group relative flex w-full cursor-pointer items-start justify-between gap-4 overflow-hidden rounded-[16px] border px-4 py-4 text-left transition-colors duration-150 focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus"
export const CONFIG_MIDDLE_ITEM_ACTIVE_CLASS = "border-border-base bg-surface-base-active"
export const CONFIG_MIDDLE_ITEM_INACTIVE_CLASS =
  "inset-control border-border-weak-base bg-background-base hover:border-border-base hover:bg-surface-base-hover"

type ProviderSdkBadge = ProviderChipProps

export function providerSdkBadge(item: ConfigProviderItem): ProviderSdkBadge | undefined {
  if (!item.sdk) return undefined

  const sdk = item.sdk.toLowerCase()
  const identity = `${item.id} ${item.name}`.toLowerCase()

  if (identity.includes("deepseek")) return { label: "DeepSeek", icon: "deepseek", tone: "deepseek" }
  if (identity.includes("anthropic") || identity.includes("claude") || sdk.includes("anthropic")) {
    return { label: "Claude Code", icon: "anthropic", tone: "claude" }
  }
  if (item.id === "openai") return { label: "OpenAI", icon: "openai", tone: "openai" }
  if (identity.includes("codex") || sdk === "@ai-sdk/openai") {
    return { label: "Codex", icon: "openai", tone: "codex" }
  }
  if (sdk.includes("openai")) return { label: "OpenAI", icon: "openai", tone: "openai" }
  if (sdk.includes("google")) return { label: "Google", icon: "google", tone: "neutral" }
  if (sdk.includes("xai")) return { label: "xAI", icon: "xai", tone: "neutral" }
  if (sdk.includes("mistral")) return { label: "Mistral", icon: "mistral", tone: "neutral" }

  return { label: item.sdk.replace(/^@ai-sdk\//, ""), icon: item.id, tone: "neutral" }
}

export function ProviderListButton(props: {
  active: boolean
  disabled?: boolean
  item: ConfigProviderItem
  models: string
  onClick: () => void
  extra?: JSX.Element
}) {
  const badge = createMemo(() => providerSdkBadge(props.item))
  const press = (event: KeyboardEvent) => {
    if (props.disabled) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onClick()
  }

  return (
    <div
      data-config-provider-item
      role="button"
      tabIndex={props.disabled ? -1 : 0}
      aria-disabled={props.disabled}
      class={CONFIG_MIDDLE_ITEM_CLASS}
      classList={{
        [CONFIG_MIDDLE_ITEM_ACTIVE_CLASS]: props.active && !props.disabled,
        [CONFIG_MIDDLE_ITEM_INACTIVE_CLASS]: !props.active && !props.disabled,
        "cursor-not-allowed border-border-weak-base bg-surface-secondary/60 opacity-50 grayscale": props.disabled,
      }}
      onClick={() => {
        if (props.disabled) return
        props.onClick()
      }}
      onKeyDown={press}
    >
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <div class="min-w-0 truncate text-15-medium text-text-interactive-base transition-colors">
            {props.item.id}
          </div>
          <span
            class="shrink-0 rounded-full border px-2 py-0.5 text-11-medium transition-colors"
            classList={{
              "border-border-base bg-surface-secondary text-text-strong": props.active && !props.disabled,
              "border-border-weak-base bg-surface-secondary/70 text-text-weak group-hover:border-border-base group-hover:bg-surface-secondary group-hover:text-text-base":
                !props.active || props.disabled,
            }}
          >
            {props.models}
          </span>
        </div>
        <Show when={badge()}>
          {(value) => (
            <div class="mt-3">
              <ProviderChip {...value()} />
            </div>
          )}
        </Show>
      </div>
      <Show when={props.extra}>
        <div
          class="shrink-0 pt-0.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {props.extra}
        </div>
      </Show>
    </div>
  )
}
