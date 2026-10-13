import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { TaskSort } from "./task-sort"

export function TaskSearchField(props: {
  value: string
  onChange: (value: string) => void
  sort: TaskSort
  recentLabel: string
  onSortChange: (sort: TaskSort) => void
}) {
  const language = useLanguage()
  const sortLabel = () => (props.sort === "created" ? language.t("task.sort.created") : props.recentLabel)
  return (
    <div data-slot="task-panel-search" class="mt-2 flex min-w-0 items-center gap-2">
      <div
        data-slot="task-search-input"
        class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg bg-surface-base px-3"
      >
        <Icon name="magnifying-glass" class="shrink-0 text-icon-weak-base" />
        <TextField
          variant="ghost"
          type="text"
          value={props.value}
          onChange={(value) => {
            console.debug(`[task-search] input length=${value.length}`)
            props.onChange(value)
          }}
          placeholder={language.t("task.search.placeholder")}
          aria-label={language.t("task.search.placeholder")}
          spellcheck={false}
          autocomplete="off"
          class="min-w-0 flex-1"
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Escape" || !props.value) return
            event.preventDefault()
            event.stopPropagation()
            props.onChange("")
          }}
        />
        <Show when={props.value}>
          <IconButton
            icon="circle-x"
            variant="ghost"
            aria-label={language.t("task.search.clear")}
            onClick={() => props.onChange("")}
          />
        </Show>
      </div>
      <Button
        size="small"
        variant="ghost"
        class="h-9 min-w-0 max-w-32 shrink-0 gap-1.5 rounded-lg"
        title={`${sortLabel()} · ${language.t("task.sort.toggle")}`}
        aria-label={`${language.t("task.sort.toggle")}: ${sortLabel()}`}
        aria-pressed={props.sort === "recent"}
        onClick={() => {
          const sort = props.sort === "created" ? "recent" : "created"
          console.debug(`[task-sort] toggle ${props.sort} -> ${sort}`)
          props.onSortChange(sort)
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16" fill="none" class="shrink-0">
          <path d="M4 3v14m-2.5-3L4 17l2.5-3M9 4h8M9 9h6M9 14h3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="truncate">{sortLabel()}</span>
      </Button>
    </div>
  )
}
