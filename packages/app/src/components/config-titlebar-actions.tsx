import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createMemo, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useLanguage } from "@/context/language"

export function ConfigTitlebarActions() {
  const language = useLanguage()
  const rightMount = createMemo(() => document.getElementById("opencode-titlebar-right"))

  onMount(() => {
    queueMicrotask(() => {
      const width = rightMount()?.getBoundingClientRect().width ?? 0
      console.debug(`[config-titlebar] disabled actions mounted width=${width.toFixed(1)}`)
    })
  })

  return (
    <Show when={rightMount()}>
      {(mount) => (
        <Portal mount={mount()}>
          <div data-component="config-titlebar-actions" class="flex items-center gap-2">
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

              <div class="hidden md:flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  class="titlebar-icon w-8 h-8 p-0 box-border disabled:!cursor-default"
                  disabled
                  aria-label={language.t("command.review.toggle")}
                >
                  <Icon size="normal" name="review" />
                </Button>
                <Button
                  variant="ghost"
                  class="titlebar-icon w-8 h-8 p-0 box-border disabled:!cursor-default"
                  disabled
                  aria-label={language.t("command.filePreview.toggle")}
                >
                  <Icon size="normal" name="file" />
                </Button>
                <Button
                  variant="ghost"
                  class="titlebar-icon w-8 h-8 p-0 box-border disabled:!cursor-default"
                  disabled
                  aria-label={language.t("command.fileTree.toggle")}
                >
                  <Icon size="normal" name="file-tree" />
                </Button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </Show>
  )
}
