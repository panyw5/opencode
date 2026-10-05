import { createMemo, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { getFilename } from "@opencode-ai/core/util/path"
import { useSessionHistory, type SessionHistoryEntry } from "@/context/session-history"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { extraAgentByDirectory } from "@/pages/layout/extra-agents"

export interface SessionPickerPopoverProps {
  onSelect: (entry: SessionHistoryEntry) => void | Promise<void>
  currentSessionID?: string
  triggerStyle?: JSX.CSSProperties
  triggerClass?: string
  ariaLabel: string
  emptyText: string
  headerText: string
  placement?: "top-start" | "top-end" | "top" | "bottom-start" | "bottom-end" | "bottom"
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function relativeTime(at: number, now: number): string {
  const delta = Math.max(0, now - at)
  if (delta < MINUTE) return "just now"
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d`
  return new Date(at).toLocaleDateString()
}

export function SessionPickerPopover(props: SessionPickerPopoverProps) {
  const history = useSessionHistory()
  const sync = useSync()
  const language = useLanguage()
  // Snapshot "now" once per popover open so timestamps don't churn while the
  // user is reading the list.
  const [state, setState] = createStore({ open: false, openedAt: Date.now(), query: "", loading: "", error: "" })

  const items = createMemo(() => {
    const entries = new Map(history.entries().map((entry) => [entry.id, entry]))
    for (const session of sync.data.session) {
      if (session.time.archived || extraAgentByDirectory(session.directory)) continue
      entries.set(session.id, {
        id: session.id,
        title: session.title,
        directory: session.directory,
        visitedAt: session.time.updated,
      })
    }
    const query = state.query.trim().toLocaleLowerCase()
    return [...entries.values()]
      .filter(
        (entry) =>
          entry.id !== props.currentSessionID &&
          `${entry.title} ${entry.directory} ${entry.id}`.toLocaleLowerCase().includes(query),
      )
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, 30)
  })

  const handleOpen = (next: boolean) => {
    if (next) setState({ openedAt: Date.now(), query: "", error: "" })
    setState("open", next)
  }

  const choose = async (entry: SessionHistoryEntry) => {
    if (state.loading) return
    setState({ loading: entry.id, error: "" })
    try {
      await props.onSelect(entry)
      setState("open", false)
    } catch (error) {
      console.warn(`[session-reference] load failed session=${entry.id} error=${String(error)}`)
      setState("error", language.t("prompt.session.unavailable"))
    } finally {
      setState("loading", "")
    }
  }

  return (
    <Popover
      open={state.open}
      onOpenChange={handleOpen}
      placement={props.placement ?? "top-start"}
      gutter={6}
      triggerAs={IconButton}
      triggerProps={{
        type: "button",
        icon: "quote-open",
        variant: "ghost",
        iconSize: "small",
        class: props.triggerClass ?? "size-9 shrink-0 rounded-full",
        style: props.triggerStyle,
        "aria-label": props.ariaLabel,
        "data-action": "prompt-session-history",
      }}
      class="w-[420px] max-w-[calc(100vw-40px)]"
    >
      <div class="flex flex-col gap-3">
        <div class="text-11-medium uppercase tracking-[0.08em] text-text-weak">{props.headerText}</div>
        <input
          type="search"
          class="w-full rounded-md border border-border-base px-2 py-1.5 text-13-regular bg-background-base text-text-strong"
          aria-label={language.t("prompt.session.search")}
          placeholder={language.t("prompt.session.search")}
          value={state.query}
          onInput={(event) => setState("query", event.currentTarget.value)}
        />
        <Show when={state.error}>
          <div role="alert" class="text-12-regular text-text-weak">
            {state.error}
          </div>
        </Show>
        <Show when={state.loading}>
          <div role="status" class="text-12-regular text-text-weak">
            {language.t("prompt.session.loading")}
          </div>
        </Show>
        <Show
          when={items().length > 0}
          fallback={
            <div class="text-13-regular text-text-weak px-1 py-3">
              {state.query ? language.t("prompt.session.noResults") : props.emptyText}
            </div>
          }
        >
          <ul class="flex flex-col gap-0.5 -mx-1 max-h-72 overflow-y-auto">
            <For each={items()}>
              {(entry) => {
                const projectName = () => getFilename(entry.directory) || entry.directory || "?"
                const titleText = () => entry.title?.trim() || `${entry.id.slice(0, 8)}…`
                const tooltip = () => `${entry.title || "(untitled)"}\n${entry.directory}\n${entry.id}`
                return (
                  <li>
                    <button
                      type="button"
                      class="w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left text-12-regular hover:bg-surface-hover focus:bg-surface-hover focus:outline-none"
                      title={tooltip()}
                      disabled={!!state.loading}
                      onClick={() => choose(entry)}
                    >
                      <Icon name="speech-bubble" size="small" class="mt-0.5 shrink-0 text-icon-weak" />
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-13-medium text-text-strong">{titleText()}</div>
                        <div class="truncate text-12-regular text-text-weak">
                          {projectName()} · {relativeTime(entry.visitedAt, state.openedAt)}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              }}
            </For>
          </ul>
        </Show>
      </div>
    </Popover>
  )
}
