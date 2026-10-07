import type { Todo } from "@opencode-ai/sdk/v2"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Icon } from "@opencode-ai/ui/icon"
import { Index, createMemo, createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TextStrikethrough } from "@opencode-ai/ui/text-strikethrough"

function dot(status: Todo["status"]) {
  if (status !== "in_progress") return undefined
  // 16px box (viewBox 12 scaled) keeps the visible dot column width identical
  // to the checkbox / circle-check glyphs.
  return (
    <svg
      viewBox="0 0 12 12"
      width="16"
      height="16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      class="block"
    >
      <circle
        cx="6"
        cy="6"
        r="3"
        style={{
          animation: "var(--animate-pulse-scale)",
          "transform-origin": "center",
          "transform-box": "fill-box",
        }}
      />
    </svg>
  )
}

export function TodoList(props: { todos: Todo[]; open: boolean; maxHeight?: string; completedAsCircle?: boolean }) {
  const [store, setStore] = createStore({
    stuck: false,
    scrolling: false,
  })
  let scrollRef!: HTMLDivElement
  let timer: number | undefined

  const inProgress = createMemo(() => props.todos.findIndex((todo) => todo.status === "in_progress"))
  const maxHeight = () => props.maxHeight ?? "10.5rem" // max-h-42 default for dock

  const ensure = () => {
    if (!props.open) return
    if (store.scrolling) return
    if (!scrollRef || scrollRef.offsetParent === null) return

    const el = scrollRef.querySelector("[data-in-progress]")
    if (!(el instanceof HTMLElement)) return

    const topFade = 16
    const bottomFade = 44
    const container = scrollRef.getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    const top = rect.top - container.top + scrollRef.scrollTop
    const bottom = rect.bottom - container.top + scrollRef.scrollTop
    const viewTop = scrollRef.scrollTop + topFade
    const viewBottom = scrollRef.scrollTop + scrollRef.clientHeight - bottomFade

    if (top < viewTop) {
      scrollRef.scrollTop = Math.max(0, top - topFade)
    } else if (bottom > viewBottom) {
      scrollRef.scrollTop = bottom - (scrollRef.clientHeight - bottomFade)
    }

    setStore("stuck", scrollRef.scrollTop > 0)
  }

  createEffect(
    on([() => props.open, inProgress], () => {
      if (!props.open || inProgress() < 0) return
      requestAnimationFrame(ensure)
    }),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  return (
    <div class="relative">
      <div
        class="px-3 pb-11 flex flex-col gap-2.5 overflow-y-auto no-scrollbar"
        ref={scrollRef}
        style={{ "overflow-anchor": "none", "max-height": maxHeight() }}
        onScroll={(e) => {
          setStore("stuck", e.currentTarget.scrollTop > 0)
          setStore("scrolling", true)
          if (timer) window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            setStore("scrolling", false)
            if (inProgress() < 0) return
            requestAnimationFrame(ensure)
          }, 250)
        }}
      >
        <Index each={props.todos}>
          {(todo) => (
            <div
              class="flex items-center gap-3 rounded-md px-2 py-1 -mx-2 -my-1 transition-colors duration-200"
              classList={{
                // Subtle brand-tinted pill so the running task reads at a glance.
                "bg-[color-mix(in_srgb,var(--surface-brand-base)_9%,transparent)]":
                  todo().status === "in_progress",
              }}
            >
              {/* Fixed-width icon column keeps the icon→text gap identical across statuses. */}
              <div
                class="flex w-4 shrink-0 items-center justify-center"
                classList={{ "text-icon-brand-base": todo().status === "in_progress" }}
                data-in-progress={todo().status === "in_progress" ? "" : undefined}
                data-state={todo().status}
              >
                {props.completedAsCircle && todo().status === "completed" ? (
                  <Icon name="circle-check" size="normal" class="size-4 text-icon-weak" />
                ) : todo().status === "in_progress" ? (
                  // In-progress: breathing dot only, no checkbox frame.
                  dot(todo().status)
                ) : (
                  <Checkbox
                    readOnly
                    checked={todo().status === "completed"}
                    style={{
                      "--checkbox-align": "center",
                      "--checkbox-offset": "1px",
                      transition: "opacity 220ms var(--tool-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))",
                      opacity: todo().status === "pending" ? "0.94" : "1",
                    }}
                  />
                )}
              </div>
              <TextStrikethrough
                active={todo().status === "completed" || todo().status === "cancelled"}
                text={todo().content}
                class="text-14-regular min-w-0 break-words"
                style={{
                  "line-height": "var(--line-height-normal)",
                  transition:
                    "color 220ms var(--tool-motion-ease, cubic-bezier(0.22, 1, 0.36, 1)), opacity 220ms var(--tool-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))",
                  color:
                    todo().status === "completed" || todo().status === "cancelled"
                      ? "var(--text-weak)"
                      : "var(--text-strong)",
                  opacity: todo().status === "pending" ? "0.92" : "1",
                }}
              />
            </div>
          )}
        </Index>
      </div>
      <div
        class="pointer-events-none absolute top-0 left-0 right-0 h-4 transition-opacity duration-150"
        style={{
          background: "linear-gradient(to bottom, var(--background-base), transparent)",
          opacity: store.stuck ? 1 : 0,
        }}
      />
    </div>
  )
}
