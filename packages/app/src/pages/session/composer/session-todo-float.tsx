import type { Todo } from "@opencode-ai/sdk/v2"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { SessionProjectTaskMount } from "@/components/session/session-project-task-mount"
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
  const [shown, setShown] = createSignal(false)

  const total = createMemo(() => props.todos.length)
  const done = createMemo(() => props.todos.filter((todo) => todo.status === "completed").length)
  const inProgress = createMemo(() => props.todos.some((todo) => todo.status === "in_progress"))
  const badge = createMemo(() =>
    total() > 0
      ? language.t("session.todo.badge", { done: done(), total: total() })
      : language.t("session.todo.title"),
  )

  const e2e = composerEnabled()
  const probe = composerProbe(props.sessionID)

  createEffect(() => {
    if (!e2e) return
    // Always report mounted so e2e can open the panel for project-task controls
    // even when the session has no todos yet.
    probe.set({
      mounted: true,
      collapsed: !shown(),
      hidden: false,
      count: props.todos.length,
      states: props.todos.map((todo) => todo.status),
    })
  })

  onCleanup(() => {
    if (!e2e) return
    probe.drop()
  })

  return (
    <div
      data-component="session-todo-float"
      data-action="session-todo-toggle-button"
      data-collapsed={shown() ? "false" : "true"}
      class="absolute top-14 right-3 z-20 pointer-events-auto"
    >
      <Popover
        open={shown()}
        onOpenChange={setShown}
        triggerAs="button"
        triggerProps={{
          type: "button",
          "aria-label": shown() ? props.collapseLabel : props.expandLabel,
          class:
            "inline-flex items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-2 shadow-sm text-13-medium text-text-strong hover:bg-surface-raised-base-hover transition-colors",
        }}
        trigger={
          <>
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
          </>
        }
        class="w-[500px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border-base bg-surface-raised-stronger p-0 shadow-xl"
        style={{
          "max-height": "min(680px, calc(100dvh - 24px))",
        }}
        gutter={8}
        placement="bottom-end"
      >
        <div data-slot="session-todo-float-panel" class="flex max-h-[min(680px,calc(100dvh-24px))] flex-col">
          <div class="flex items-center justify-between px-3 py-2 border-b border-border-weaker-base">
            <span class="text-13-medium text-text-strong">{language.t("session.todo.title")}</span>
            <IconButton
              data-action="session-todo-float-close"
              icon="close"
              size="normal"
              variant="ghost"
              aria-label={props.collapseLabel}
              onClick={() => setShown(false)}
            />
          </div>
          <div class="min-h-0 overflow-y-auto no-scrollbar">
            <div class="border-b border-border-weaker-base">
              <SessionProjectTaskMount variant="panel" />
            </div>
            <div class="py-2">
              <TodoList todos={props.todos} open={shown()} maxHeight="420px" />
            </div>
          </div>
        </div>
      </Popover>
    </div>
  )
}
