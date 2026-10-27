import { Component, createEffect, For, Match, onCleanup, Show, Switch } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { atCategories, type AtCategory, type AtReference } from "./at-references"

export type AtOption =
  | { type: "im"; display: string; channelName?: string; botName?: string }
  | { type: "agent"; name: string; display: string }
  | { type: "consult"; id: string; name: string; display: string }
  | { type: "file"; path: string; display: string; content?: string; recent?: boolean }

export type PromptAtOption = AtOption | AtReference

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom" | "extra-agent"
  source?: "command" | "mcp" | "skill"
  agentId?: string
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setPopoverRef: (el: HTMLDivElement) => void
  atFlat: PromptAtOption[]
  atCategory?: AtCategory
  setAtCategory?: (category: AtCategory) => void
  atLoading?: boolean
  atError?: boolean
  atActive?: string
  atKey: (item: PromptAtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: PromptAtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybind: (id: string) => string | undefined
  t: (key: string) => string
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  let surface: HTMLDivElement | undefined
  createEffect(() => {
    const kind = props.popover
    if (!kind) return
    const frame = requestAnimationFrame(() => {
      if (!surface) return
      const style = getComputedStyle(surface)
      console.debug(
        `[prompt-popover] opened kind=${kind} background=${style.backgroundColor} border=${style.borderColor} shadow=${style.boxShadow} blur=${style.backdropFilter}`,
      )
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  createEffect(() => {
    if (props.popover !== "at") return
    console.debug(`[prompt-at] loading indicator state=${props.atLoading ? "loading" : "idle"} placement=header`)
  })

  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          surface = el
          props.setPopoverRef(el)
        }}
        data-component="prompt-popover"
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-hidden flex flex-col p-2 rounded-[12px]
                 bg-surface-raised-stronger-non-alpha border border-border-weak-base/60 shadow-[var(--shadow-lg)]"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Show when={props.popover === "at"}>
          <div data-slot="prompt-at-header" class="flex items-center gap-3 shrink-0 pb-2">
            <Show when={props.setAtCategory}>
              <div class="flex gap-1.5 min-w-0 flex-1 overflow-x-auto no-scrollbar" role="tablist">
                <For each={atCategories}>
                  {(category) => (
                    <button
                      type="button"
                      role="tab"
                      tabIndex={-1}
                      aria-selected={props.atCategory === category}
                      class="inline-flex min-h-9 shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-3 py-1.5 text-12-medium transition-colors duration-150 motion-reduce:transition-none"
                      classList={{
                        "bg-surface-interactive-weak-hover border-border-selected/30 text-text-strong":
                          props.atCategory === category,
                        "border-transparent text-text-weak hover:bg-surface-base-hover hover:border-border-weak-base/60 hover:text-text-strong":
                          props.atCategory !== category,
                      }}
                      onClick={() => props.setAtCategory?.(category)}
                      onMouseEnter={() =>
                        console.debug(
                          `[prompt-at] category hover category=${category} selected=${props.atCategory === category}`,
                        )
                      }
                    >
                      {props.t(`prompt.at.category.${category}`)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={props.atLoading}>
              <div
                data-slot="prompt-at-loading"
                role="status"
                class="ml-auto shrink-0 whitespace-nowrap px-2 py-1 text-12-regular text-text-weak"
              >
                {props.t("prompt.at.loading")}
              </div>
            </Show>
          </div>
        </Show>
        <div data-prompt-popover-list class="min-h-0 overflow-y-auto no-scrollbar">
          <Switch>
            <Match when={props.popover === "at"}>
              <Show when={props.atError}>
                <div class="text-text-weak px-2 py-1">{props.t("prompt.at.loadFailed")}</div>
              </Show>
              <Show
                when={props.atFlat.length > 0}
                fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyResults")}</div>}
              >
                <For each={props.atFlat}>
                  {(item) => {
                    const key = props.atKey(item)

                    if (item.type === "session" || item.type === "projectTask" || item.type === "scheduledTask") {
                      return (
                        <button
                          type="button"
                          data-prompt-popover-active={props.atActive === key ? "" : undefined}
                          class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5 text-14-regular text-text-strong"
                          classList={{ "bg-surface-raised-base-active": props.atActive === key }}
                          onClick={() => props.onAtSelect(item)}
                          onMouseEnter={() => props.setAtActive(key)}
                        >
                          <Icon name="prompt" size="small" />
                          <span class="truncate">{item.name}</span>
                          <span class="text-text-weak text-11-regular truncate">{item.id}</span>
                        </button>
                      )
                    }

                    if (item.type === "im") {
                      return (
                        <button
                          type="button"
                          data-prompt-popover-active={props.atActive === key ? "" : undefined}
                          class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                          classList={{ "bg-surface-raised-base-active": props.atActive === key }}
                          onClick={() => props.onAtSelect(item)}
                          onMouseEnter={() => props.setAtActive(key)}
                        >
                          <Icon name="prompt" size="small" class="text-icon-info-active shrink-0" />
                          <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.display}</span>
                        </button>
                      )
                    }

                    if (item.type === "agent" || item.type === "consult") {
                      return (
                        <button
                          type="button"
                          data-prompt-popover-active={props.atActive === key ? "" : undefined}
                          class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                          classList={{ "bg-surface-raised-base-active": props.atActive === key }}
                          onClick={() => props.onAtSelect(item)}
                          onMouseEnter={() => props.setAtActive(key)}
                        >
                          <Icon
                            name={item.type === "consult" ? "review" : "brain"}
                            size="small"
                            class="text-icon-info-active shrink-0"
                          />
                          <span class="text-14-regular text-text-strong whitespace-nowrap">@{item.name}</span>
                          <Show when={item.type === "consult"}>
                            <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded shrink-0">
                              {props.t("prompt.at.badge.consult")}
                            </span>
                          </Show>
                        </button>
                      )
                    }

                    const displayPath = item.display || item.path
                    const isDirectory = displayPath.endsWith("/")
                    const directory = isDirectory ? displayPath : getDirectory(displayPath)
                    const filename = isDirectory ? "" : getFilename(displayPath)

                    return (
                      <button
                        type="button"
                        data-prompt-popover-active={props.atActive === key ? "" : undefined}
                        class="w-full flex items-center gap-x-2 rounded-md px-2 py-0.5"
                        classList={{ "bg-surface-raised-base-active": props.atActive === key }}
                        onClick={() => props.onAtSelect(item)}
                        onMouseEnter={() => props.setAtActive(key)}
                      >
                        <FileIcon
                          node={{ path: item.path, type: isDirectory ? "directory" : "file" }}
                          class="shrink-0 size-4"
                        />
                        <div class="flex items-center gap-1.5 text-14-regular min-w-0">
                          <Show when={!isDirectory}>
                            <span class="text-14-medium text-text-strong whitespace-nowrap">{filename}</span>
                          </Show>
                          <span class="text-text-weak whitespace-nowrap truncate min-w-0">{directory}</span>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </Match>
            <Match when={props.popover === "slash"}>
              <Show
                when={props.slashFlat.length > 0}
                fallback={<div class="text-text-weak px-2 py-1">{props.t("prompt.popover.emptyCommands")}</div>}
              >
                <For each={props.slashFlat}>
                  {(cmd) => (
                    <button
                      type="button"
                      data-slash-id={cmd.id}
                      data-prompt-popover-active={props.slashActive === cmd.id ? "" : undefined}
                      classList={{
                        "w-full flex items-center justify-between gap-4 rounded-md px-2 py-1": true,
                        "bg-surface-raised-base-hover": props.slashActive === cmd.id,
                      }}
                      onClick={() => props.onSlashSelect(cmd)}
                      onMouseEnter={() => props.setSlashActive(cmd.id)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-14-regular text-text-strong whitespace-nowrap">/{cmd.trigger}</span>
                        <Show when={cmd.description}>
                          <span class="text-14-regular text-text-weak truncate">{cmd.description}</span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                          <span class="text-11-regular text-text-subtle px-1.5 py-0.5 bg-surface-base rounded">
                            {cmd.source === "skill"
                              ? props.t("prompt.slash.badge.skill")
                              : cmd.source === "mcp"
                                ? props.t("prompt.slash.badge.mcp")
                                : props.t("prompt.slash.badge.custom")}
                          </span>
                        </Show>
                        <Show when={props.commandKeybind(cmd.id)}>
                          <span class="text-12-regular text-text-subtle">{props.commandKeybind(cmd.id)}</span>
                        </Show>
                      </div>
                    </button>
                  )}
                </For>
              </Show>
            </Match>
          </Switch>
        </div>
      </div>
    </Show>
  )
}
