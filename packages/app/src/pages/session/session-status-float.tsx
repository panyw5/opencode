import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Popover } from "@opencode-ai/ui/popover"
import { For, Show, createSignal } from "solid-js"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useLanguage } from "@/context/language"

export function SessionStatusFloat(props: { skills: string[] }) {
  const language = useLanguage()
  const [shown, setShown] = createSignal(false)

  return (
    <div
      data-component="session-status-float"
      data-action="session-status-toggle-button"
      data-expanded={shown() ? "true" : "false"}
      class="absolute top-3 right-3 z-20 pointer-events-auto"
    >
      <Popover
        open={shown()}
        onOpenChange={setShown}
        triggerAs="button"
        triggerProps={{
          type: "button",
          "aria-label": shown() ? language.t("session.status.collapse") : language.t("session.status.expand"),
          class:
            "inline-flex items-center gap-1.5 rounded-full border border-border-weak-base bg-surface-raised-base px-3 py-2 shadow-sm text-13-medium text-text-strong hover:bg-surface-raised-base-hover transition-colors",
        }}
        trigger={
          <>
            <Icon name="status" size="small" class="text-icon-weak" />
            <span>{language.t("session.status.button")}</span>
          </>
        }
        class="w-[500px] max-w-[calc(100vw-24px)] overflow-hidden rounded-xl border border-border-base bg-surface-raised-stronger p-0 shadow-xl"
        style={{
          "max-height": "min(680px, calc(100dvh - 24px))",
        }}
        gutter={8}
        placement="bottom-end"
      >
        <div data-slot="session-status-float-panel" class="flex max-h-[min(680px,calc(100dvh-24px))] flex-col">
          <div class="flex items-center justify-between px-3 py-2 border-b border-border-weaker-base">
            <span class="text-13-medium text-text-strong">{language.t("session.status.skills")}</span>
            <IconButton
              data-action="session-status-float-close"
              icon="close"
              size="normal"
              variant="ghost"
              aria-label={language.t("session.status.collapse")}
              onClick={() => setShown(false)}
            />
          </div>
          <div class="min-h-0 overflow-y-auto no-scrollbar">
            <div class="border-b border-border-weaker-base py-2">
              <Show
                when={props.skills.length > 0}
                fallback={<p class="px-3 py-4 text-13-regular text-text-weak">{language.t("session.status.empty")}</p>}
              >
                <ul class="flex flex-wrap gap-2 px-3 py-2">
                  <For each={props.skills}>
                    {(skill) => (
                      <li class="inline-flex items-center gap-1.5 rounded-full border border-border-weaker-base bg-surface-base px-2.5 py-1 text-12-regular text-text-strong">
                        <Icon name="check" size="small" class="text-icon-success-base" />
                        <code class="font-mono">{skill}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </div>
            <SessionContextUsage variant="panel" />
          </div>
        </div>
      </Popover>
    </div>
  )
}
