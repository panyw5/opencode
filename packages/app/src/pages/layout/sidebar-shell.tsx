import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { ConstrainDragXAxis } from "@/utils/solid-dnd"
import { IconButton } from "@opencode-ai/ui/icon-button"
import type { IconName } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Icon } from "@opencode-ai/ui/icon"
import { Mark } from "@opencode-ai/ui/logo"
import { type LocalProject } from "@/context/layout"
import { ScoopJoin } from "./scoop-join"
import { RailTooltip } from "./rail-tooltip"
import type { StashedRailEntry } from "./sidebar-panel-stash"

export type SidebarExtraAgent = {
  id: string
  label: Accessor<string>
  active?: Accessor<boolean>
  available?: Accessor<boolean>
  healthy?: Accessor<boolean | undefined>
  icon: IconName
  onOpen: () => void
}

export type SidebarImChannel = {
  id: string
  label: Accessor<string>
  meta?: Accessor<string | undefined>
  active?: Accessor<boolean>
  available?: Accessor<boolean>
  icon: IconName
  onOpen: () => void
}

export const SidebarContent = (props: {
  mobile?: boolean
  opened: Accessor<boolean>
  homeLabel: Accessor<string>
  homeActive: Accessor<boolean>
  onOpenHome: () => void
  projects: Accessor<LocalProject[]>
  renderProject: (project: LocalProject) => JSX.Element
  handleDragStart: (event: unknown) => void
  handleDragOver: (event: DragEvent) => void
  handleDragEnd: (event: DragEvent) => void
  openProjectLabel: JSX.Element
  openProjectKeybind: Accessor<string | undefined>
  onOpenProject: () => void
  renderProjectOverlay: () => JSX.Element
  extraAgents: Accessor<SidebarExtraAgent[]>
  imChannels?: Accessor<SidebarImChannel[]>
  imChannelsLabel?: Accessor<string>
  onOpenImChannelsConfig?: () => void
  configLabel: Accessor<string>
  configKeybind: Accessor<string | undefined>
  configActive: Accessor<boolean>
  onOpenConfig: () => void
  onPrefetchConfig?: () => void
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
  onOpenSettings: () => void
  helpLabel: Accessor<string>
  onOpenHelp: () => void
  /** Parked items (minimized panels, editor dialogs), most recent first. */
  stashedEntries: Accessor<StashedRailEntry[]>
  stashLabel: Accessor<string>
  onRestoreEntry: (entry: StashedRailEntry) => void
  onRemoveEntry: (entry: StashedRailEntry) => void
  renderPanel: () => JSX.Element
}): JSX.Element => {
  const expanded = createMemo(() => !!props.mobile || props.opened())
  const placement = () => (props.mobile ? "bottom" : "right")
  let panel: HTMLDivElement | undefined

  // Extra agents menu state
  const [menuOpen, setMenuOpen] = createSignal(false)
  let closeTimer: number | undefined

  // IM channels menu state
  const [imMenuOpen, setImMenuOpen] = createSignal(false)
  let imCloseTimer: number | undefined

  const activeAgent = createMemo(() => props.extraAgents().find((agent) => agent.active?.()))
  const activeImChannel = createMemo(() => props.imChannels?.().find((ch) => ch.active?.()))
  // GeneralAgent is the framework shell entry. The rail always shows a stable
  // framework icon; which backend is active is a domain-internal detail revealed
  // by the popover selector below.
  const entryIcon = createMemo<IconName>(() => (props.extraAgents().length > 0 ? "robot" : "dot-grid"))

  const handleMenuMouseEnter = () => {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = undefined
    }
    setMenuOpen(true)
  }

  const handleMenuMouseLeave = () => {
    closeTimer = window.setTimeout(() => {
      setMenuOpen(false)
    }, 200)
  }

  const handleImMenuMouseEnter = () => {
    if (imCloseTimer) {
      clearTimeout(imCloseTimer)
      imCloseTimer = undefined
    }
    setImMenuOpen(true)
  }

  const handleImMenuMouseLeave = () => {
    imCloseTimer = window.setTimeout(() => {
      setImMenuOpen(false)
    }, 200)
  }

  // The stash menu is the stable home for minimized entries, even when there is one.
  const [stashMenuOpen, setStashMenuOpen] = createSignal(false)
  let stashCloseTimer: number | undefined

  const stashHead = createMemo(() => props.stashedEntries()[0])
  const stashTitle = () => {
    const items = props.stashedEntries()
    return items.length === 1 ? items[0]!.label : props.stashLabel()
  }

  const handleStashMouseEnter = () => {
    if (stashCloseTimer) {
      clearTimeout(stashCloseTimer)
      stashCloseTimer = undefined
    }
    setStashMenuOpen(true)
  }

  const handleStashMouseLeave = () => {
    stashCloseTimer = window.setTimeout(() => {
      setStashMenuOpen(false)
    }, 200)
  }

  onCleanup(() => {
    if (closeTimer) {
      clearTimeout(closeTimer)
    }
    if (imCloseTimer) {
      clearTimeout(imCloseTimer)
    }
    if (stashCloseTimer) {
      clearTimeout(stashCloseTimer)
    }
  })

  createEffect(() => {
    const el = panel
    if (!el) return
    if (expanded()) {
      el.removeAttribute("inert")
      return
    }
    el.setAttribute("inert", "")
  })

  return (
    <div class="flex h-full w-full min-w-0 overflow-hidden">
      <div
        data-component="sidebar-rail"
        class="relative z-20 w-16 shrink-0 bg-background-base flex flex-col items-center overflow-hidden arc-sidebar-scope"
      >
        <div class="shrink-0 flex w-full flex-col items-center px-2 pt-3 pb-2">
          <RailTooltip mobile={props.mobile} title={props.homeLabel()} inactive={props.homeActive()}>
            <button
              type="button"
              data-action="home-open"
              aria-label={props.homeLabel()}
              aria-current={props.homeActive() ? "page" : undefined}
              style={{ transform: props.homeActive() ? "translateY(-3px) scale(1.16)" : undefined }}
              class="flex size-10 items-center justify-center rounded-full outline-none transition-all duration-150 focus-visible:ring-2 focus-visible:ring-border-focus"
              classList={{
                "relative z-10 border-2 border-border-interactive-selected bg-surface-interactive-weak text-icon-strong shadow-md":
                  props.homeActive(),
                "border border-transparent bg-transparent text-icon-weak hover:border-border-base hover:bg-surface-base-hover hover:text-icon-base active:scale-[0.96]":
                  !props.homeActive(),
              }}
              onClick={props.onOpenHome}
            >
              <Mark class="size-5" />
            </button>
          </RailTooltip>
          <Show when={props.stashedEntries().length > 0}>
            <Popover
              open={stashMenuOpen()}
              onOpenChange={setStashMenuOpen}
              placement={placement()}
              trigger={
                <div class="mt-2" onMouseEnter={handleStashMouseEnter} onMouseLeave={handleStashMouseLeave}>
                  <RailTooltip mobile={props.mobile} title={stashTitle()} inactive={stashMenuOpen()}>
                    <IconButton
                      icon="panel-stash"
                      variant="ghost"
                      size="large"
                      data-action="panel-stash"
                      classList={{ "bg-surface-base-active": stashMenuOpen() }}
                      aria-label={props.stashLabel()}
                      onClick={() => {
                        const head = stashHead()
                        if (head) props.onRestoreEntry(head)
                      }}
                    />
                  </RailTooltip>
                </div>
              }
            >
              <div
                class="flex flex-col gap-1 p-2 min-w-[200px]"
                onMouseEnter={handleStashMouseEnter}
                onMouseLeave={handleStashMouseLeave}
              >
                <For each={props.stashedEntries()}>
                  {(entry) => (
                    <div
                      class="flex items-center gap-1 rounded-md transition-colors hover:bg-surface-base-hover"
                      data-stashed-entry={entry.id}
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-text-base"
                        onClick={() => props.onRestoreEntry(entry)}
                      >
                        <Icon name={entry.icon} class="size-5 shrink-0" />
                        <span class="min-w-0 flex-1 truncate text-left text-14-regular">{entry.label}</span>
                      </button>
                      <IconButton
                        icon="close-small"
                        variant="ghost"
                        size="small"
                        class="!mr-1 !size-5 !rounded-full border border-transparent text-icon-base transition-colors hover:!border-border-critical-base hover:!bg-surface-critical-weak hover:!text-text-critical-base active:!bg-surface-critical-base active:scale-[0.94]"
                        aria-label={`${props.stashLabel()}: ${entry.label}`}
                        data-action="panel-stash-remove"
                        onClick={(event) => {
                          event.stopPropagation()
                          props.onRemoveEntry(entry)
                        }}
                      />
                    </div>
                  )}
                </For>
              </div>
            </Popover>
          </Show>
          <div aria-hidden="true" class="mt-3 h-px w-7 bg-border-weaker-base" />
        </div>
        <div class="flex-1 min-h-0 w-full">
          <DragDropProvider
            onDragStart={props.handleDragStart}
            onDragOver={props.handleDragOver}
            onDragEnd={props.handleDragEnd}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragXAxis />
            <div class="h-full w-full flex flex-col items-center px-2 py-3 overflow-y-auto no-scrollbar">
              <SortableProvider ids={props.projects().map((p) => p.worktree)}>
                <For each={props.projects()}>{(project) => props.renderProject(project)}</For>
              </SortableProvider>
              <div class="py-1.5">
                <RailTooltip
                  mobile={props.mobile}
                  title={typeof props.openProjectLabel === "string" ? props.openProjectLabel : ""}
                  keybind={props.mobile ? undefined : props.openProjectKeybind()}
                >
                  <IconButton
                    icon="plus"
                    variant="ghost"
                    size="large"
                    onClick={props.onOpenProject}
                    aria-label={typeof props.openProjectLabel === "string" ? props.openProjectLabel : undefined}
                  />
                </RailTooltip>
              </div>
            </div>
            <DragOverlay>{props.renderProjectOverlay()}</DragOverlay>
          </DragDropProvider>
        </div>
        <div class="shrink-0 w-full pt-3 pb-6 flex flex-col items-center gap-2">
          <Show when={props.extraAgents().length > 0}>
            <Popover
              open={menuOpen()}
              onOpenChange={setMenuOpen}
              placement={placement()}
              trigger={
                <div onMouseEnter={handleMenuMouseEnter} onMouseLeave={handleMenuMouseLeave}>
                  <RailTooltip mobile={props.mobile} title="GeneralAgent" inactive={menuOpen()}>
                    <IconButton
                      icon={entryIcon()}
                      variant="ghost"
                      size="large"
                      classList={{ "bg-surface-base-active": !!activeAgent() }}
                      aria-label="GeneralAgent"
                    />
                  </RailTooltip>
                </div>
              }
            >
              <div
                class="flex flex-col gap-1 p-2 min-w-[160px]"
                onMouseEnter={handleMenuMouseEnter}
                onMouseLeave={handleMenuMouseLeave}
              >
                <For each={props.extraAgents()}>
                  {(agent) => (
                    <button
                      class="flex items-center gap-2 px-3 py-2 rounded-md text-text-base hover:bg-surface-base-hover transition-colors"
                      classList={{
                        "bg-surface-base-active": !!agent.active?.(),
                        "opacity-50 cursor-not-allowed hover:bg-transparent": agent.available?.() === false,
                      }}
                      disabled={agent.available?.() === false}
                      onClick={() => {
                        agent.onOpen()
                        setMenuOpen(false)
                      }}
                    >
                      <Icon name={agent.icon} class="size-5 shrink-0" />
                      <span class="text-14-regular flex-1 text-left">{agent.label()}</span>
                      <Show when={agent.healthy}>
                        <span
                          aria-hidden="true"
                          class="size-1.5 shrink-0 rounded-full"
                          classList={{
                            "bg-icon-success-base": agent.healthy?.() === true,
                            "bg-icon-critical-base": agent.healthy?.() === false,
                            "bg-border-weak-base": agent.healthy?.() === undefined,
                          }}
                        />
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Popover>
          </Show>
          <Show when={(props.imChannels?.().length ?? 0) > 0 || !!props.onOpenImChannelsConfig}>
            <Popover
              open={imMenuOpen()}
              onOpenChange={setImMenuOpen}
              placement={placement()}
              trigger={
                <div onMouseEnter={handleImMenuMouseEnter} onMouseLeave={handleImMenuMouseLeave}>
                  <RailTooltip mobile={props.mobile} title={props.imChannelsLabel?.() ?? "IM"} inactive={imMenuOpen()}>
                    <IconButton
                      icon="speech-bubble"
                      variant="ghost"
                      size="large"
                      classList={{ "bg-surface-base-active": !!activeImChannel() }}
                      aria-label={props.imChannelsLabel?.() ?? "IM"}
                    />
                  </RailTooltip>
                </div>
              }
            >
              <div
                class="flex flex-col gap-1 p-2 min-w-[180px]"
                onMouseEnter={handleImMenuMouseEnter}
                onMouseLeave={handleImMenuMouseLeave}
              >
                <Show
                  when={(props.imChannels?.().length ?? 0) > 0}
                  fallback={
                    <button
                      class="flex items-center gap-2 px-3 py-2 rounded-md text-text-weak hover:bg-surface-base-hover transition-colors text-left"
                      onClick={() => {
                        props.onOpenImChannelsConfig?.()
                        setImMenuOpen(false)
                      }}
                    >
                      <Icon name="plus-small" class="size-5 shrink-0" />
                      <span class="text-14-regular">{props.imChannelsLabel?.() ?? "Channels"}</span>
                    </button>
                  }
                >
                  <For each={props.imChannels?.() ?? []}>
                    {(ch) => (
                      <button
                        class="flex items-center gap-2 px-3 py-2 rounded-md text-text-base hover:bg-surface-base-hover transition-colors"
                        classList={{
                          "bg-surface-base-active": !!ch.active?.(),
                          "opacity-50 cursor-not-allowed hover:bg-transparent": ch.available?.() === false,
                        }}
                        disabled={ch.available?.() === false}
                        onClick={() => {
                          ch.onOpen()
                          setImMenuOpen(false)
                        }}
                      >
                        <Icon name={ch.icon} class="size-5 shrink-0" />
                        <span class="text-14-regular flex-1 text-left min-w-0">
                          <span class="block truncate">{ch.label()}</span>
                          <Show when={ch.meta?.()}>
                            <span class="block truncate text-11-regular text-text-weaker">{ch.meta!()}</span>
                          </Show>
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </Popover>
          </Show>
          <RailTooltip mobile={props.mobile} title={props.configLabel()} keybind={props.configKeybind()}>
            <IconButton
              icon="sliders"
              variant="ghost"
              size="large"
              classList={{ "bg-surface-base-active": props.configActive() }}
              onClick={() => props.onOpenConfig()}
              onPointerEnter={() => props.onPrefetchConfig?.()}
              onFocus={() => props.onPrefetchConfig?.()}
              aria-label={props.configLabel()}
            />
          </RailTooltip>
          <RailTooltip mobile={props.mobile} title={props.settingsLabel()} keybind={props.settingsKeybind()}>
            <IconButton
              icon="settings-gear"
              variant="ghost"
              size="large"
              onClick={props.onOpenSettings}
              aria-label={props.settingsLabel()}
            />
          </RailTooltip>
          <RailTooltip mobile={props.mobile} title={props.helpLabel()}>
            <IconButton
              icon="help"
              variant="ghost"
              size="large"
              onClick={props.onOpenHelp}
              aria-label={props.helpLabel()}
            />
          </RailTooltip>
        </div>
      </div>

      <div
        ref={(el) => {
          panel = el
        }}
        classList={{
          // Layout slot only — no full-width paint. Open/close is the nav width.
          // Scoop fill below paints chrome under the panel's top-left radius so
          // the concave join is intentional (rail/titlebar color), not a hole
          // into the main pane.
          "relative z-10 flex-1 flex h-full min-h-0 min-w-0 overflow-hidden arc-sidebar-scope": true,
          "pointer-events-none": !expanded(),
        }}
        aria-hidden={!expanded()}
      >
        <ScoopJoin class="left-0 z-0" />
        <div class="relative z-[1] flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {props.renderPanel()}
        </div>
      </div>
    </div>
  )
}
