import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { createMemo, Show, type JSX } from "solid-js"
import type { ConfigProviderItem } from "./config-provider-list"

export const CONFIG_MIDDLE_ITEM_CLASS =
  "group relative flex w-full cursor-pointer items-start justify-between gap-4 overflow-hidden rounded-lg border px-4 py-4 text-left transition-[background-color,border-color,box-shadow,transform] duration-150 focus:outline-none focus-visible:border-border-strong focus-visible:bg-surface-base-hover"
export const CONFIG_MIDDLE_ITEM_ACTIVE_CLASS =
  "border-border-weak-base bg-[linear-gradient(105deg,color-mix(in_srgb,var(--surface-brand-base)_8%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-base)_3%,var(--background-base)))]"
export const CONFIG_MIDDLE_ITEM_INACTIVE_CLASS =
  "border-border-weak-base/75 bg-background-base/60 hover:-translate-y-px hover:border-border-base hover:bg-background-base"

type ProviderSdkBadgeTone = "codex" | "claude" | "deepseek" | "openai" | "neutral"

type ProviderSdkBadge = {
  label: string
  icon: string
  tone: ProviderSdkBadgeTone
}

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

function ProviderSdkChip(props: { badge: ProviderSdkBadge }) {
  return (
    <span
      class="inline-flex h-7 w-fit items-center gap-1.5 rounded-full border px-2.5 text-12-medium shadow-[0_8px_20px_-16px_rgba(0,0,0,0.65)]"
      classList={{
        "border-[#74d6ca]/45 bg-[#2f8179] text-white": props.badge.tone === "codex",
        "border-[#d16b27]/30 bg-[#fff0d8] text-[#a33f0a]": props.badge.tone === "claude",
        "border-[#7daeff]/50 bg-[#dceaff] text-[#1856c9]": props.badge.tone === "deepseek",
        "border-border-strong-base bg-surface-base text-text-base": props.badge.tone === "openai",
        "border-border-weak-base bg-surface-secondary text-text-base": props.badge.tone === "neutral",
      }}
    >
      <ProviderIcon id={props.badge.icon} class="size-4 shrink-0" />
      <span>{props.badge.label}</span>
    </span>
  )
}

export function ProviderListButton(props: {
  active: boolean
  item: ConfigProviderItem
  models: string
  onClick: () => void
  extra?: JSX.Element
}) {
  const badge = createMemo(() => providerSdkBadge(props.item))
  const press = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onClick()
  }

  return (
    <div
      role="button"
      tabIndex={0}
      class={CONFIG_MIDDLE_ITEM_CLASS}
      classList={{
        [CONFIG_MIDDLE_ITEM_ACTIVE_CLASS]: props.active,
        [CONFIG_MIDDLE_ITEM_INACTIVE_CLASS]: !props.active,
      }}
      onClick={props.onClick}
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
              "border-border-base bg-surface-secondary text-text-base": props.active,
              "border-border-weak-base bg-surface-secondary/70 text-text-weak": !props.active,
            }}
          >
            {props.models}
          </span>
        </div>
        <Show when={badge()}>
          {(value) => (
            <div class="mt-3">
              <ProviderSdkChip badge={value()} />
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
