import { Icon, type IconProps } from "@opencode-ai/ui/icon"

export function SectionButton(props: { current: boolean; title: string; icon: IconProps["name"]; onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-current={props.current ? "page" : undefined}
      class="group relative flex w-full items-center justify-between gap-3 overflow-hidden rounded-[16px] border px-3 py-3.5 text-left transition-all duration-150 focus:outline-none focus-visible:border-border-strong focus-visible:bg-surface-base-hover"
      classList={{
        "border-transparent bg-transparent hover:border-border-base hover:bg-surface-base-active": !props.current,
        "border-border-base bg-[linear-gradient(135deg,color-mix(in_srgb,var(--surface-base-active)_92%,white_8%),color-mix(in_srgb,var(--surface-base-active)_72%,transparent))]":
          props.current,
      }}
      onClick={props.onClick}
    >
      <div
        class="absolute top-3 bottom-3 left-1.5 w-0.5 rounded-full bg-border-strong transition-opacity duration-150"
        classList={{
          "opacity-0": !props.current,
          "opacity-70": props.current,
        }}
      />
      <div class="flex min-w-0 items-center gap-3">
        <div
          class="flex size-8 shrink-0 items-center justify-center rounded-[10px] border transition-all duration-150"
          classList={{
            "border-transparent text-text-weak group-hover:border-border-base group-hover:bg-background-base/65 group-hover:text-text-strong":
              !props.current,
            "border-border-weak-base bg-background-base/55 text-text-strong": props.current,
          }}
        >
          <Icon name={props.icon} size="medium" />
        </div>
        <div class="truncate text-16-medium text-text-strong transition-colors">{props.title}</div>
      </div>
      <div
        class="size-1.5 shrink-0 rounded-full bg-border-strong transition-all duration-150"
        classList={{
          "scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-45": !props.current,
          "opacity-55": props.current,
        }}
      />
    </button>
  )
}
