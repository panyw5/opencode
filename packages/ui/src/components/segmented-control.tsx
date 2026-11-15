import { createMemo, For, type JSX } from "solid-js"

export type SegmentedControlOption<T extends string = string> = {
  value: T
  label: JSX.Element
  /** Optional content rendered after the label (e.g. a status icon). */
  trailing?: JSX.Element
  disabled?: boolean
}

export type SegmentedControlProps<T extends string = string> = {
  options: readonly SegmentedControlOption<T>[]
  /** Currently selected value. A value outside `options` hides the indicator (nothing selected). */
  current?: string
  onSelect?: (value: T) => void
  disabled?: boolean
  size?: "small" | "medium"
  /** Stretch to fill the container width (options stay equal-width). */
  fill?: boolean
  /**
   * ARIA semantics: `group` (default) renders `role="group"` with `aria-pressed` buttons;
   * `tablist` renders `role="tablist"`/`role="tab"` with roving tabindex and arrow-key navigation.
   */
  variant?: "group" | "tablist"
  /** Required for `variant="tablist"`: emits `${id}-tab-${value}` ids and `${id}-panel` aria-controls. */
  id?: string
  "aria-label"?: string
  /** Stamps `data-{name}={option.value}` on each option button (test hooks). */
  optionDataKey?: string
  class?: string
  style?: JSX.CSSProperties | string
}

export function SegmentedControl<T extends string = string>(props: SegmentedControlProps<T>) {
  let ref: HTMLDivElement | undefined
  const activeIndex = createMemo(() => props.options.findIndex((option) => option.value === props.current))
  const tablist = () => props.variant === "tablist"

  const onKeyDown = (event: KeyboardEvent) => {
    if (!tablist() || props.disabled) return
    const index = activeIndex()
    let next = index
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % props.options.length
        break
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + props.options.length) % props.options.length
        break
      case "Home":
        next = 0
        break
      case "End":
        next = props.options.length - 1
        break
      default:
        return
    }
    event.preventDefault()
    const option = props.options[next]
    if (!option || option.disabled) return
    props.onSelect?.(option.value)
    ref?.querySelectorAll<HTMLButtonElement>('[data-slot="segmented-control-option"]')[next]?.focus()
  }

  return (
    <div
      ref={ref}
      data-component="segmented-control"
      data-size={props.size ?? "small"}
      data-fill={props.fill ? "" : undefined}
      role={tablist() ? "tablist" : "group"}
      aria-label={props["aria-label"]}
      class={props.class}
      style={props.style}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden="true"
        data-slot="segmented-control-indicator"
        data-hidden={activeIndex() < 0 ? "" : undefined}
        style={{
          "--segmented-control-count": String(props.options.length),
          transform: `translateX(${Math.max(0, activeIndex()) * 100}%)`,
        }}
      />
      <For each={props.options}>
        {(option) => {
          const active = () => option.value === props.current
          return (
            <button
              type="button"
              data-slot="segmented-control-option"
              data-active={active() ? "true" : undefined}
              {...(props.optionDataKey ? { [`data-${props.optionDataKey}`]: option.value } : {})}
              role={tablist() ? "tab" : undefined}
              id={tablist() && props.id ? `${props.id}-tab-${option.value}` : undefined}
              aria-controls={tablist() && props.id ? `${props.id}-panel` : undefined}
              aria-selected={tablist() ? active() : undefined}
              aria-pressed={tablist() ? undefined : active()}
              tabIndex={tablist() ? (active() ? 0 : -1) : undefined}
              disabled={props.disabled || option.disabled}
              onClick={() => props.onSelect?.(option.value)}
            >
              {option.label}
              {option.trailing}
            </button>
          )
        }}
      </For>
    </div>
  )
}
