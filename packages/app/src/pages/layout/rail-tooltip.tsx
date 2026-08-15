import { createEffect, createSignal, For, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

const MODIFIER_GLYPHS = new Set(["⌘", "⇧", "⌃", "⌥"])

function RailKeybind(props: { value: string }) {
  return (
    <span class="inline-flex items-center gap-px text-14-medium text-text-weak">
      <For each={Array.from(props.value)}>
        {(ch) => (
          <span
            classList={{
              "inline-flex items-center text-[16px] leading-none": MODIFIER_GLYPHS.has(ch),
            }}
          >
            {ch}
          </span>
        )}
      </For>
    </span>
  )
}

export function RailTooltip(props: {
  mobile?: boolean
  title: string
  keybind?: string
  inactive?: boolean
  children: JSX.Element
}): JSX.Element {
  const [pos, setPos] = createSignal<{ left: number; top: number; x: string }>()
  let node: HTMLDivElement | undefined

  const hide = () => setPos(undefined)

  const show = () => {
    if (props.inactive || !node) return
    const rect = node.getBoundingClientRect()
    setPos(
      props.mobile
        ? { left: rect.left + rect.width / 2, top: rect.bottom + 8, x: "-50%" }
        : { left: rect.right + 10, top: rect.top + rect.height / 2, x: "0" },
    )
  }

  createEffect(() => {
    if (props.inactive) hide()
  })

  return (
    <>
      <div
        ref={(el) => {
          node = el
        }}
        class="flex"
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusIn={show}
        onFocusOut={hide}
      >
        {props.children}
      </div>
      <Portal>
        <Show when={pos()}>
          {(p) => (
            <div
              data-component="project-rail-label"
              class="pointer-events-none fixed z-[100] flex items-center gap-2 whitespace-nowrap rounded-lg border border-border-strong-base bg-surface-float-base-hover px-3 py-1.5 text-14-medium text-text-strong shadow-lg"
              style={{
                left: `${p().left}px`,
                top: `${p().top}px`,
                transform: `translate(${p().x}, ${props.mobile ? "0" : "-50%"})`,
              }}
            >
              <span>{props.title}</span>
              <Show when={props.keybind}>
                {(keybind) => <RailKeybind value={keybind()} />}
              </Show>
            </div>
          )}
        </Show>
      </Portal>
    </>
  )
}
