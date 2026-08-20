import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"

const MODIFIER_GLYPHS = new Set(["⌘", "⇧", "⌃", "⌥"])

// Chromium/Electron re-fires pointerenter when the window regains focus (e.g. Cmd+Tab)
// while the cursor is still over a trigger. Gate hover tooltips until the pointer moves.
let pointerArmed = true
let armListenerCount = 0
let removeArmListeners: (() => void) | undefined

function ensurePointerArmListeners() {
  if (armListenerCount++ > 0) return

  const disarm = () => {
    pointerArmed = false
  }
  const onBlur = () => disarm()
  const onVisibility = () => {
    if (document.visibilityState === "hidden") disarm()
  }
  const onPointerMove = (e: PointerEvent) => {
    if (pointerArmed) return
    if (e.movementX === 0 && e.movementY === 0) return
    pointerArmed = true
  }

  window.addEventListener("blur", onBlur)
  document.addEventListener("visibilitychange", onVisibility)
  window.addEventListener("pointermove", onPointerMove)
  removeArmListeners = () => {
    window.removeEventListener("blur", onBlur)
    document.removeEventListener("visibilitychange", onVisibility)
    window.removeEventListener("pointermove", onPointerMove)
    removeArmListeners = undefined
  }
}

function releasePointerArmListeners() {
  if (--armListenerCount > 0) return
  removeArmListeners?.()
  pointerArmed = true
}

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

  const place = () => {
    if (!node) return
    const rect = node.getBoundingClientRect()
    setPos(
      props.mobile
        ? { left: rect.left + rect.width / 2, top: rect.bottom + 8, x: "-50%" }
        : { left: rect.right + 10, top: rect.top + rect.height / 2, x: "0" },
    )
  }

  const showFromPointer = () => {
    if (props.inactive || !node || !pointerArmed) return
    place()
  }

  const showFromKeyboardFocus = (e: FocusEvent) => {
    if (props.inactive || !node) return
    const target = e.target as HTMLElement | null
    // Mouse clicks and window focus restore should not open the tooltip.
    if (!target?.matches?.(":focus-visible")) return
    place()
  }

  createEffect(() => {
    if (props.inactive) hide()
  })

  onMount(() => {
    ensurePointerArmListeners()
    const onBlur = () => hide()
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hide()
    }
    window.addEventListener("blur", onBlur)
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      window.removeEventListener("blur", onBlur)
      document.removeEventListener("visibilitychange", onVisibility)
      releasePointerArmListeners()
    })
  })

  return (
    <>
      <div
        ref={(el) => {
          node = el
        }}
        class="flex"
        onPointerEnter={showFromPointer}
        onPointerLeave={hide}
        onFocusIn={showFromKeyboardFocus}
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
