import { ProviderChip, type ProviderChipProps } from "@/components/provider-chip"
import { createMemo, Show, type JSX } from "solid-js"
import type { ConfigProviderItem } from "./config-provider-list"

export const CONFIG_MIDDLE_ITEM_CLASS =
  "group relative flex w-full cursor-pointer items-start justify-between gap-4 overflow-hidden rounded-lg border px-4 py-4 text-left transition-[background-color,border-color,box-shadow] duration-150 focus:outline-none focus-visible:border-[color-mix(in_srgb,var(--surface-brand-base)_40%,var(--border-strong))] focus-visible:bg-[color-mix(in_srgb,var(--surface-brand-base)_10%,var(--background-base))] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--surface-brand-base)_14%,transparent)]"
export const CONFIG_MIDDLE_ITEM_ACTIVE_CLASS =
  "border-[color-mix(in_srgb,var(--surface-brand-base)_48%,var(--border-base))] bg-[linear-gradient(105deg,color-mix(in_srgb,var(--surface-brand-base)_22%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-base)_10%,var(--background-base)))] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--surface-brand-base)_22%,transparent),0_12px_28px_-16px_color-mix(in_srgb,var(--surface-brand-base)_50%,transparent)]"
export const CONFIG_MIDDLE_ITEM_INACTIVE_CLASS =
  "border-border-weak-base bg-background-base/80 hover:border-[color-mix(in_srgb,var(--surface-brand-base)_30%,var(--border-base))] hover:bg-[color-mix(in_srgb,var(--surface-brand-base)_12%,var(--background-base))] hover:shadow-[0_12px_26px_-16px_color-mix(in_srgb,black_55%,transparent)]"

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
              "border-[color-mix(in_srgb,var(--surface-brand-base)_35%,var(--border-base))] bg-[color-mix(in_srgb,var(--surface-brand-base)_14%,var(--surface-secondary))] text-text-strong":
                props.active && !props.disabled,
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
