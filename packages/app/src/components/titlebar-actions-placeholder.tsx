import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createMemo, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { browserApi } from "@/browser/types"
import { SessionPanelTriggerIcon, sessionPanelTriggerClass } from "./session/session-panel-menu"

/**
 * Disabled mirror of the session header actions. Surfaces without a session
 * (home, config) mount this into the titlebar right slot so the session tabs
 * keep the same available width when switching between routes.
 */
export function TitlebarActionsPlaceholder(props: { surface: string }) {
  const language = useLanguage()
  const rightMount = createMemo(() => document.getElementById("opencode-titlebar-right"))

  onMount(() => {
    queueMicrotask(() => {
      const width = rightMount()?.getBoundingClientRect().width ?? 0
      console.debug(
        `[titlebar-actions] placeholder mounted surface=${props.surface} width=${width.toFixed(1)}`,
      )
    })
  })

  return (
    <Show when={rightMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div data-component={`${props.surface}-titlebar-actions`} class="flex items-center gap-2">
            <div class="hidden xl:flex items-center">
              <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                <Button
                  variant="ghost"
                  class="rounded-none h-full px-0.5 border-none shadow-none disabled:!cursor-default"
                  disabled
                  aria-label={language.t("session.header.open.copyPath")}
                >
                  <div class="flex size-5 shrink-0 items-center justify-center">
                    <Icon name="folder" size="small" />
                  </div>
                </Button>
                <IconButton
                  icon="chevron-down"
                  variant="ghost"
                  disabled
                  class="rounded-none h-full w-[20px] p-0 border-none shadow-none disabled:!cursor-default"
                  aria-label={language.t("session.header.open.menu")}
                />
              </div>
            </div>

            <Button
              variant="ghost"
              class="titlebar-icon w-8 h-8 p-0 box-border disabled:!cursor-default"
              disabled
              aria-label={language.t("status.popover.trigger")}
            >
              <Icon name="status" size="normal" />
            </Button>

            <div class="flex items-center gap-1">
              <Button
                variant="ghost"
                class="titlebar-icon w-8 h-8 p-0 box-border shrink-0 disabled:!cursor-default"
                disabled
                aria-label={language.t("command.terminal.toggle")}
              >
                <Icon size="normal" name="terminal" />
              </Button>

              <Show when={browserApi()}>
                <Button
                  variant="ghost"
                  class="titlebar-icon w-8 h-8 p-0 box-border shrink-0 disabled:!cursor-default"
                  disabled
                  aria-label={language.t("command.browser.toggle")}
                >
                  <Icon size="normal" name="globe" />
                </Button>
              </Show>

               <div data-slot="session-panel-actions" class="hidden md:flex items-center shrink-0">
                 <Button
                   variant="ghost"
                   class={sessionPanelTriggerClass + " disabled:!cursor-default"}
                   disabled
                   aria-label={language.t("session.panel.reviewAndFiles")}
                 >
                   <SessionPanelTriggerIcon />
                </Button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
}
