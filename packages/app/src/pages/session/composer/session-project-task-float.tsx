import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { createMemo, createSignal, Show } from "solid-js"
import { pendingProjectTaskMount } from "@/components/session/pending-project-task-mount"
import { SessionProjectTaskMount } from "@/components/session/session-project-task-mount"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"

/**
 * Project-task capsule (top-right of the session). Session todos used to be
 * listed here too; they now live in the hover capsule above the prompt input
 * (see session-todo-hover.tsx), so this panel is only about the mounted task.
 */
export function SessionProjectTaskFloat(props: { sessionID?: string; collapseLabel: string; expandLabel: string }) {
  const language = useLanguage()
  const sync = useSync()
  const sdk = useSDK()
  const [shown, setShown] = createSignal(false)

  // Existing session uses the server-mounted task, a new session (no session
  // row yet) falls back to the local pending selection.
  const directory = createMemo(() => sdk.directory)
  const session = createMemo(() => {
    const id = props.sessionID
    if (!id) return undefined
    return sync.session.get(id)
  })
  const pending = createMemo(() => pendingProjectTaskMount(directory()))
  const mounted = createMemo(() => !!(session()?.mountedTaskID ?? pending().taskID))
  const badge = createMemo(() =>
    mounted() ? language.t("session.todo.mounted") : language.t("projectTask.mount.none"),
  )

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
            <Icon name="checklist" size="small" class={mounted() ? "text-icon-brand-base" : "text-icon-weak"} />
            <span>{badge()}</span>
          </>
        }
        class="w-[680px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border-base bg-surface-raised-stronger p-0 shadow-xl"
        style={{
          "max-height": "min(680px, calc(100dvh - 24px))",
        }}
        gutter={8}
        placement="bottom-end"
      >
        <div data-slot="session-todo-float-panel" class="flex max-h-[min(680px,calc(100dvh-24px))] flex-col">
          <div class="flex items-center justify-between px-3 py-2 border-b border-border-weaker-base">
            <span class="text-13-medium text-text-strong">{language.t("projectTask.title")}</span>
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
            <SessionProjectTaskMount variant="panel" onOpenTask={() => setShown(false)} />
          </div>
        </div>
      </Popover>
    </div>
  )
}
