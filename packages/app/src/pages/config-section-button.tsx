import { Icon, type IconProps } from "@opencode-ai/ui/icon"

export function SectionButton(props: {
  current: boolean
  title: string
  description?: string
  icon: IconProps["name"]
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      aria-current={props.current ? "page" : undefined}
      class="group relative flex min-h-14 w-full items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] duration-150 focus:outline-none focus-visible:border-border-strong"
      classList={{
        "border-transparent bg-transparent hover:border-[color-mix(in_srgb,var(--surface-brand-base)_24%,var(--border-weak-base))] hover:bg-[color-mix(in_srgb,var(--surface-brand-base)_10%,var(--background-base))] hover:shadow-[0_10px_22px_-16px_color-mix(in_srgb,black_45%,transparent)]":
          !props.current,
        "border-[color-mix(in_srgb,var(--surface-brand-base)_40%,var(--border-weak-base))] bg-[linear-gradient(105deg,color-mix(in_srgb,var(--surface-brand-base)_22%,var(--background-base)),color-mix(in_srgb,var(--surface-brand-base)_10%,var(--background-base)))] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--surface-brand-base)_18%,transparent)]":
          props.current,
      }}
      onClick={props.onClick}
    >
      <div
        class="relative z-[1] flex size-8 shrink-0 items-center justify-center rounded-lg border transition-[background-color,border-color,color] duration-150"
        classList={{
          "border-border-weak-base bg-background-base/75 text-text-weak group-hover:border-border-base group-hover:text-text-strong":
            !props.current,
          "border-[color-mix(in_srgb,var(--surface-brand-base)_34%,var(--border-weak-base))] bg-[color-mix(in_srgb,var(--surface-brand-base)_15%,var(--background-base))] text-text-strong":
            props.current,
        }}
      >
        <Icon name={props.icon} size="medium" />
      </div>
      <div class="relative z-[1] min-w-0 flex-1">
        <div
          class="truncate text-14-medium transition-colors"
          classList={{
            "text-text-base group-hover:text-text-strong": !props.current,
            "text-text-strong": props.current,
          }}
        >
          {props.title}
        </div>
        {props.description && (
          <div class="mt-0.5 line-clamp-2 text-[11px] leading-4 text-text-weak">{props.description}</div>
        )}
      </div>
    </button>
  )
}
