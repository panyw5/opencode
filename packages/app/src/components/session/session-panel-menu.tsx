import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Keybind } from "@opencode-ai/ui/keybind"
import { Popover } from "@opencode-ai/ui/popover"
import { For, onCleanup, Show, type ComponentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { formatKeybind, useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

export const sessionPanelTriggerClass = "titlebar-icon w-10 h-8 !gap-0 p-0 box-border"

export function SessionPanelTriggerIcon(props: { active?: boolean }) {
  return (
    <>
      <Icon name={props.active ? "layout-right-partial" : "layout-right"} size="normal" />
      <Icon name="chevron-down" size="small" class="!size-3" />
    </>
  )
}

type Panel = {
  id: "fileTree" | "filePreview" | "review"
  icon: ComponentProps<typeof Icon>["name"]
  opened: () => boolean
  toggle: () => void
}

export function SessionPanelMenu(props: { panels: Panel[] }) {
  const language = useLanguage()
  const command = useCommand()
  const [state, setState] = createStore({ open: false, hover: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  let root: HTMLDivElement | undefined
  let list: HTMLDivElement | undefined
  const clear = () => clearTimeout(timer)
  onCleanup(clear)

  const setOpen = (open: boolean, hover = false) => {
    clear()
    setState({ open, hover })
  }
  const enter = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return
    clear()
    if (!state.open) timer = setTimeout(() => setOpen(true, true), 100)
  }
  const leave = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return
    clear()
    // Give the pointer time to cross the gap between the trigger and the popover.
    if (state.hover) timer = setTimeout(() => setOpen(false), 180)
  }
  const focusFirst = () => {
    setOpen(true)
    queueMicrotask(() => list?.querySelector("button")?.focus({ preventScroll: true }))
  }

  return (
    <div ref={root} data-slot="session-panel-actions" class="hidden md:flex items-center shrink-0">
      <Popover
        open={state.open}
        onOpenChange={(open) => setOpen(open)}
        placement="bottom-end"
        triggerAs={Button}
        triggerProps={{
          variant: "ghost",
          class: sessionPanelTriggerClass + " data-[expanded]:bg-surface-raised-base-active",
          "aria-label": language.t("session.panel.reviewAndFiles"),
          onPointerEnter: enter,
          onPointerLeave: leave,
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            focusFirst()
          },
        }}
        trigger={<SessionPanelTriggerIcon active={props.panels.some((panel) => panel.opened())} />}
        class="[&>[data-slot=popover-body]]:p-0"
      >
        <div
          ref={list}
          data-slot="session-panel-menu"
          class="flex flex-col gap-0.5 p-1"
          onPointerEnter={clear}
          onPointerLeave={leave}
        >
          <For each={props.panels}>
            {(panel) => {
              const keybind = () => command.keybind(`${panel.id}.toggle`)
              return (
                <Button
                  variant="ghost"
                  class="!justify-start w-full !gap-2 !px-2 hover:!bg-[color-mix(in_srgb,var(--text-strong)_12%,transparent)] focus-visible:!bg-[color-mix(in_srgb,var(--text-strong)_12%,transparent)] active:!bg-[color-mix(in_srgb,var(--text-strong)_18%,transparent)]"
                  data-action={`session-${panel.id}-toggle`}
                  aria-pressed={panel.opened()}
                  onFocus={(event: FocusEvent & { currentTarget: HTMLButtonElement }) => {
                    if (event.currentTarget.matches(":focus-visible")) setOpen(true)
                  }}
                  onClick={(event: MouseEvent) => {
                    panel.toggle()
                    if (event.detail === 0) root?.querySelector("button")?.focus({ preventScroll: true })
                    setOpen(false)
                  }}
                >
                  <Icon name={panel.icon} size="small" />
                  <span class="flex-1 text-left">{language.t(`command.${panel.id}.toggle`)}</span>
                  <Show when={keybind()}>
                    {(bind) => <Keybind aria-hidden="true">{formatKeybind(bind(), language.t)}</Keybind>}
                  </Show>
                  <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                    <Show when={panel.opened()}>
                      <Icon name="check-small" size="small" />
                    </Show>
                  </span>
                </Button>
              )
            }}
          </For>
        </div>
      </Popover>
    </div>
  )
}
