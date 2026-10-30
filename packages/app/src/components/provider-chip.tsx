import { ProviderIcon } from "@opencode-ai/ui/provider-icon"

export type ProviderChipTone = "codex" | "claude" | "deepseek" | "openai" | "neutral"

export type ProviderChipProps = {
  label: string
  icon: string
  tone: ProviderChipTone
}

export function ProviderChip(props: ProviderChipProps) {
  return (
    <span
      data-component="provider-chip"
      data-tone={props.tone}
      class="inline-flex h-7 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-12-medium shadow-[0_8px_20px_-16px_rgba(0,0,0,0.65)]"
      classList={{
        "border-[#74d6ca]/45 bg-[#2f8179] text-[#ffffff]": props.tone === "codex",
        "border-[#d16b27]/30 bg-[#fff0d8] text-[#a33f0a]": props.tone === "claude",
        "border-[#7daeff]/50 bg-[#dceaff] text-[#1856c9]": props.tone === "deepseek",
        "border-border-strong-base bg-surface-base text-text-base": props.tone === "openai",
        "border-border-weak-base bg-surface-secondary text-text-base": props.tone === "neutral",
      }}
    >
      <ProviderIcon id={props.icon} class="size-4 shrink-0" aria-hidden="true" />
      <span>{props.label}</span>
    </span>
  )
}
