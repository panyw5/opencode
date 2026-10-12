import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"

export function TaskSearchField(props: { value: string; onChange: (value: string) => void }) {
  const language = useLanguage()
  return (
    <div data-slot="task-panel-search" class="mt-2 flex h-9 items-center gap-2 rounded-lg bg-surface-base px-3">
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
  )
}
