import type { Todo } from "@opencode-ai/sdk/v2"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useSpring } from "@opencode-ai/ui/motion-spring"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { TodoList } from "@/pages/session/composer/session-todo-list"
import { composerEnabled, composerProbe } from "@/testing/session-composer"

export function SessionTodoFloat(props: {
  sessionID?: string
  todos: Todo[]
  collapseLabel: string
  expandLabel: string
}) {
  const language = useLanguage()
  const [collapsed, setCollapsed] = createSignal(true)
  const toggle = () => setCollapsed((value) => !value)

  const total = createMemo(() => props.todos.length)
  const done = createMemo(() => props.todos.filter((todo) => todo.status === "completed").length)
  const inProgress = createMemo(() => props.todos.some((todo) => todo.status === "in_progress"))
  const badge = createMemo(() => language.t("session.todo.badge", { done: done(), total: total() }))

  const e2e = composerEnabled()
  const probe = composerProbe(props.sessionID)

  createEffect(() => {
    if (!e2e) return
    probe.set({
      mounted: true,
      collapsed: collapsed(),
      hidden: false,
      count: props.todos.length,
      states: props.todos.map((todo) => todo.status),
    })
  })

  onCleanup(() => {
    if (!e2e) return
    probe.drop()
  })

  const progress = useSpring(() => (collapsed() ? 0 : 1), { visualDuration: 0.25, bounce: 0 })
  const value = createMemo(() => Math.max(0, Math.min(1, progress())))
  const visible = createMemo(() => !collapsed() || value() > 0.001)

  return (
    <div
      data-component="session-todo-float"
      class="absolute top-3 right-3 z-20 flex flex-col items-end gap-2 pointer-events-auto"
    >
      <button
        type="button"
        data-component="session-todo-float-toggle"
        data-action="session-todo-toggle-button"
        data-collapsed={collapsed() ? "true" : "false"}
        aria-label={collapsed() ? props.expandLabel : props.collapseLabel}
        onClick={toggle}
        class="inline-flex items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-2 shadow-sm text-13-medium text-text-strong hover:bg-surface-raised-base-hover transition-colors"
      >
        <Show when={inProgress()}>
          <span
            class="size-1.5 rounded-full bg-icon-warning-base"
            style={{
              animation: "var(--animate-pulse-scale)",
              "transform-origin": "center",
            }}
          />
        </Show>
        <span>{badge()}</span>
      </button>

      <Show when={visible()}>
        <div
          data-slot="session-todo-float-panel"
          class="w-[500px] max-w-[calc(100vw-24px)] rounded-xl border border-border-base bg-surface-raised-stronger shadow-xl overflow-hidden"
          style={{
            "max-height": `${280 * value()}px`,
            opacity: `${value()}`,
            "pointer-events": collapsed() ? "none" : "auto",
          }}
        >
          <div class="flex items-center justify-between px-3 py-2 border-b border-border-weaker-base">
            <span class="text-13-medium text-text-strong">{language.t("session.todo.title")}</span>
            <IconButton
              data-action="session-todo-float-close"
              icon="close"
              size="normal"
              variant="ghost"
              aria-label={props.collapseLabel}
              onClick={toggle}
            />
          </div>
          <div class="max-h-60 overflow-y-auto no-scrollbar py-2">
            <TodoList todos={props.todos} open={!collapsed()} />
          </div>
        </div>
      </Show>
    </div>
  )
}
