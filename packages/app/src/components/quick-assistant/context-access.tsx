import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export type ContextAccess = {
  sessionID: string
  title: string
  directory: string
  readFiles: boolean
}

export function QuickAssistantContextAccess(props: {
  references: ContextAccess[]
  disabled: boolean
  onFiles: (sessionID: string, value: boolean) => void
}) {
  const language = useLanguage()
  return (
    <Show when={props.references.length}>
      <div
        data-component="quick-assistant-context-access"
        class="mx-2 mb-2 max-h-36 space-y-1 overflow-y-auto border-t border-border-weak-base px-1 pt-2"
      >
        <div class="text-11-regular text-text-weak">{language.t("quickAssistant.access.scope")}</div>
        <For each={props.references}>
          {(item) => (
            <label class="flex min-w-0 items-center gap-2 text-12-regular text-text-base" title={item.directory}>
              <input
                type="checkbox"
                data-action="quick-assistant-project-read"
                data-session-id={item.sessionID}
                checked={item.readFiles}
                disabled={props.disabled}
                onChange={(event) => props.onFiles(item.sessionID, event.currentTarget.checked)}
              />
              <span class="shrink-0">{language.t("quickAssistant.access.files")}</span>
              <span class="flex min-w-0 flex-col text-text-weak">
                <span class="truncate">{item.title}</span>
                <span class="truncate text-11-regular">{item.directory}</span>
              </span>
            </label>
          )}
        </For>
      </div>
    </Show>
  )
}
