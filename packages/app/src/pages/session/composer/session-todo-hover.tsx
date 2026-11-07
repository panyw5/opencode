import type { Todo } from "@opencode-ai/sdk/v2"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { createEffect, createMemo, createSignal, on, onCleanup, Show, type ComponentProps } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { TodoList } from "@/pages/session/composer/session-todo-list"
import { composerEnabled, composerProbe } from "@/testing/session-composer"

// Hover intent: opening immediately on enter feels twitchy while moving the
// pointer across the composer, closing immediately makes the trigger→panel
// travel (8px gutter) drop the panel. Both sides get a small grace window.
const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 220
// Re-fetching on every hover would hammer the endpoint while the pointer
// sweeps the composer; SSE already keeps the cache warm.
const REFRESH_INTERVAL_MS = 3_000

export function SessionTodoHover(props: { sessionID?: string; todos: Todo[] }) {
  const language = useLanguage()
  const sync = useSync()
  const [open, setOpen] = createSignal(false)
  const [clipped, setClipped] = createSignal(false)
  let openTimer: number | undefined
  let closeTimer: number | undefined
  let lastRefresh = 0
  let listRef: HTMLDivElement | undefined

  const total = createMemo(() => props.todos.length)
  const done = createMemo(() => props.todos.filter((todo) => todo.status === "completed").length)
  const running = createMemo(() => props.todos.some((todo) => todo.status === "in_progress"))
  const badge = createMemo(() => language.t("session.todo.badge", { done: done(), total: total() }))

  const clearTimers = () => {
    if (openTimer !== undefined) {
      window.clearTimeout(openTimer)
      openTimer = undefined
    }
    if (closeTimer !== undefined) {
      window.clearTimeout(closeTimer)
      closeTimer = undefined
    }
  }

  const schedule = (next: boolean) => {
    clearTimers()
    const delay = next ? OPEN_DELAY_MS : CLOSE_DELAY_MS
    const timer = window.setTimeout(() => {
      openTimer = undefined
      closeTimer = undefined
      setOpen(next)
    }, delay)
    if (next) openTimer = timer
    else closeTimer = timer
  }

  const enter = () => schedule(true)
  const leave = () => schedule(false)
  // Pointer moved into the panel: keep it open without a pending timer.
  const hold = () => clearTimers()

  onCleanup(clearTimers)

  createEffect(
    on(
      () => [open(), props.sessionID] as const,
      ([shown, id]) => {
        if (!shown || !id) return
        const now = Date.now()
        if (now - lastRefresh < REFRESH_INTERVAL_MS) return
        lastRefresh = now
        console.log(`[session-todo-hover] open refresh session=${id} count=${props.todos.length}`)
        void sync.session.todo(id, { force: true }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`[session-todo-hover] refresh failed session=${id} err=${message}`)
        })
      },
    ),
  )

  // The panel hides its scrollbar, so a long list would otherwise look like it
  // simply stops mid-row. Fade the last few pixels whenever the list overflows.
  createEffect(() => {
    if (!open()) return
    const el = listRef
    if (!el) return
    const update = () => setClipped(el.scrollHeight - el.clientHeight > 1)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    const inner = el.firstElementChild
    if (inner instanceof HTMLElement) observer.observe(inner)
    onCleanup(() => observer.disconnect())
  })

  const e2e = composerEnabled()
  const probe = composerProbe(props.sessionID)

  createEffect(() => {
    if (!e2e) return
    probe.set({
      mounted: true,
      collapsed: !open(),
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
    <div data-component="session-todo-hover" class="pointer-events-auto" onPointerEnter={enter} onPointerLeave={leave}>
      <Popover
        open={open()}
        onOpenChange={setOpen}
        triggerAs="button"
        triggerProps={
          {
            type: "button",
            "data-action": "session-todo-hover-button",
            "aria-label": language.t("session.todo.title"),
            class:
              "inline-flex items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-2.5 py-0.5 text-12-medium text-text-weak shadow-sm transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong data-[expanded]:bg-surface-raised-base-active data-[expanded]:text-text-strong",
          } as ComponentProps<"button">
        }
        trigger={
          <>
            <Icon name="checklist" size="small" class="text-icon-weak" />
            <Show when={running()}>
              <span
                class="size-1.5 rounded-full bg-icon-warning-base"
                style={{
                  animation: "var(--animate-pulse-scale)",
                  "transform-origin": "center",
                }}
              />
            </Show>
            <span class="tabular-nums">{badge()}</span>
          </>
        }
        // popover-body carries 14px padding by default; the panel owns its own
        // spacing so the list can scroll edge to edge. Width is inline because
        // popover-content pins max-width at 320px: the panel sizes itself to the
        // longest row (max-content) up to a generous ceiling, and only wraps past
        // that. overflow-hidden keeps the negative bottom margin inside the shell.
        class="overflow-hidden p-0 [&>[data-slot=popover-body]]:p-0"
        style={{
          width: "max-content",
          "min-width": "320px",
          "max-width": "min(680px, calc(100vw - 24px))",
        }}
        gutter={8}
        placement="top-end"
      >
        <div
          data-slot="session-todo-hover-panel"
          class="flex max-h-[min(420px,60dvh)] flex-col"
          onPointerEnter={hold}
          onPointerLeave={leave}
        >
          <div class="flex items-center justify-between gap-2 border-b border-border-weaker-base px-3 py-2">
            <span class="text-13-medium text-text-strong">{language.t("session.todo.title")}</span>
            <span class="text-11-regular tabular-nums text-text-weak">
              {done()}/{total()}
            </span>
          </div>
          {/* The panel scrolls as one surface (top aligned, like a peek list)
              instead of letting TodoList own a second nested scroller: nested
              scrollers cut a row at both edges of a small popover. TodoList also
              reserves 44px at the bottom for the dock fade, so that reserve is
              pulled back here. */}
          <div
            ref={(el) => (listRef = el)}
            class="min-h-0 overflow-y-auto no-scrollbar"
            style={{
              "mask-image": clipped() ? "linear-gradient(to bottom, #000 calc(100% - 20px), transparent)" : undefined,
            }}
          >
            <div class="pt-2 -mb-8">
              <TodoList
              todos={props.todos}
              open={open()}
              maxHeight="none"
              completedAsCircle
              textClass="text-[15px]"
              itemLineHeight="24px"
              gap="12px"
            />
            </div>
          </div>
        </div>
      </Popover>
    </div>
  )
}
