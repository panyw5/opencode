import type { Todo } from "@opencode-ai/sdk/v2"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { Index, createMemo, createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TextStrikethrough } from "@opencode-ai/ui/text-strikethrough"

function dot(status: Todo["status"]) {
  if (status !== "in_progress") return undefined
  return (
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
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

export function TodoList(props: { todos: Todo[]; open: boolean }) {
  const [store, setStore] = createStore({
    stuck: false,
    scrolling: false,
  })
  let scrollRef!: HTMLDivElement
  let timer: number | undefined

  const inProgress = createMemo(() => props.todos.findIndex((todo) => todo.status === "in_progress"))

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
        class="px-3 pb-11 flex flex-col gap-1.5 max-h-42 overflow-y-auto no-scrollbar"
        ref={scrollRef}
        style={{ "overflow-anchor": "none" }}
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
            <Checkbox
              readOnly
              checked={todo().status === "completed"}
              indeterminate={todo().status === "in_progress"}
              data-in-progress={todo().status === "in_progress" ? "" : undefined}
              data-state={todo().status}
              icon={dot(todo().status)}
              style={{
                "--checkbox-align": "center",
                "--checkbox-offset": "1px",
                transition: "opacity 220ms var(--tool-motion-ease, cubic-bezier(0.22, 1, 0.36, 1))",
                opacity: todo().status === "pending" ? "0.94" : "1",
              }}
            >
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
            </Checkbox>
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
