import { Icon, type IconName } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { For, Show, type Accessor, type JSX } from "solid-js"

/** Humanize a snake/kebab status string (shared by Trellis + project tasks). */
export const labelStatus = (status: string) =>
  status
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ") || "Unknown"

export type TaskProgressKind = "empty" | "quarter" | "half" | "three-quarter" | "complete"

export function progressKindForStatus(status: string, opts?: { current?: boolean; completedAt?: string | null }): TaskProgressKind {
  if (opts?.completedAt || status === "done" || status === "completed" || status === "archived") return "complete"
  if (status === "review") return "three-quarter"
  if (status === "in_progress" || status === "implementing") return "half"
  if (status === "planning" || status === "open") return "quarter"
  return "empty"
}

export function progressIconName(kind: TaskProgressKind): IconName {
  if (kind === "complete") return "progress-complete"
  if (kind === "three-quarter") return "progress-three-quarter"
  if (kind === "half") return "progress-half"
  if (kind === "quarter") return "progress-quarter"
  return "progress-empty"
}

export function progressColorClass(kind: TaskProgressKind, opts?: { active?: boolean }): string {
  if (opts?.active) return "text-icon-brand-base"
  if (kind === "complete") return "text-icon-success-base"
  if (kind === "three-quarter") return "text-icon-warning-base"
  if (kind === "half") return "text-icon-brand-base"
  if (kind === "quarter") return "text-icon-info-base"
  return "text-icon-base"
}

export function Empty(props: { text: string }): JSX.Element {
  return <div class="px-4 py-10 text-center text-14-regular text-text-base">{props.text}</div>
}

export function ErrorCard(props: { err: string }): JSX.Element {
  return (
    <div class="rounded-xl border border-border-critical-base bg-surface-critical-base px-3 py-3 text-13-regular text-text-strong">
      {props.err}
    </div>
  )
}

/** Shared sidebar panel chrome used by Trellis + project task managers. */
export function TaskPanelShell(props: {
  mobile?: boolean
  width: Accessor<number>
  title: string
  backLabel: string
  onBack: () => void
  newLabel?: string
  onNew?: () => void
  newDisabled?: boolean
  refreshLabel: string
  onRefresh: () => void
  refreshDisabled?: boolean
  children: JSX.Element
  "data-panel"?: string
}): JSX.Element {
  return (
    <div
      data-component="sidebar-panel"
      data-panel={props["data-panel"]}
      class="flex h-full min-h-0 min-w-0 flex-col rounded-tl-[12px] border-l border-t border-border-weaker-base bg-background-base px-3"
      style={{ width: props.mobile ? undefined : `${props.width()}px` }}
    >
      <div class="shrink-0 px-1 py-3">
        <div class="flex items-start justify-between gap-2 py-1 pl-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <Tooltip placement="bottom" value={props.backLabel}>
                <IconButton
                  icon="arrow-left"
                  variant="ghost"
                  size="large"
                  class="-ml-1 rounded-lg"
                  aria-label={props.backLabel}
                  onClick={props.onBack}
                />
              </Tooltip>
              <div class="text-14-medium text-text-strong">{props.title}</div>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Show when={props.onNew}>
              <Tooltip placement="bottom" value={props.newLabel ?? ""}>
                <IconButton
                  icon="plus"
                  variant="ghost"
                  size="large"
                  class="rounded-lg"
                  disabled={props.newDisabled}
                  aria-label={props.newLabel}
                  onClick={props.onNew}
                />
              </Tooltip>
            </Show>
            <Tooltip placement="bottom" value={props.refreshLabel}>
              <IconButton
                icon="refresh"
                variant="ghost"
                size="large"
                class="rounded-lg"
                disabled={props.refreshDisabled}
                aria-label={props.refreshLabel}
                onClick={props.onRefresh}
              />
            </Tooltip>
          </div>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto no-scrollbar px-1 pb-4">{props.children}</div>
    </div>
  )
}

export function TaskCardShell(props: {
  title: string
  subtitle?: string
  active?: boolean
  activeBadge?: string
  progressKind: TaskProgressKind
  badges?: string[]
  statusLabel: string
  meta?: string[]
  onOpen: () => void
  actions?: JSX.Element
  "data-component"?: string
}): JSX.Element {
  const icon = () => progressIconName(props.progressKind)
  const iconColor = () => progressColorClass(props.progressKind, { active: props.active })

  const onKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    props.onOpen()
  }

  return (
    <div
      data-component={props["data-component"] ?? "task-list-item"}
      role="button"
      tabIndex={0}
      class="group/task w-full rounded-xl border border-border-weak-base bg-background-stronger px-3 py-3 text-left transition-colors hover:bg-surface-base-hover"
      classList={{ "border-border-brand-base bg-surface-interactive-selected/40": !!props.active }}
      onClick={() => props.onOpen()}
      onKeyDown={onKeyDown}
    >
      <div class="flex items-start gap-3">
        <div
          class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border-weak-base bg-background-base"
          classList={{ [iconColor()]: true, "text-icon-brand-base": !!props.active }}
        >
          <Icon name={icon()} size="small" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <div class="min-w-0 truncate text-14-medium text-text-strong">{props.title}</div>
            <For each={props.badges ?? []}>
              {(badge) => (
                <span class="shrink-0 rounded-full bg-surface-base/20 px-2 py-0.5 text-11-medium text-text-base">
                  {badge}
                </span>
              )}
            </For>
            <Show when={props.activeBadge}>
              {(label) => (
                <span class="shrink-0 rounded-full bg-surface-info-base px-2 py-0.5 text-11-medium text-text-strong">
                  {label()}
                </span>
              )}
            </Show>
          </div>
          <Show when={props.subtitle}>
            <div class="mt-1 truncate text-12-regular text-text-base">{props.subtitle}</div>
          </Show>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-12-regular">
            <span class="rounded-md bg-surface-base/20 px-1.5 py-0.5 text-text-strong">{props.statusLabel}</span>
            <For each={props.meta ?? []}>
              {(item) => <span class="rounded-md bg-surface-base/20 px-1.5 py-0.5 text-text-base">{item}</span>}
            </For>
          </div>
          <Show when={props.actions}>
            <div class="mt-2 flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
              {props.actions}
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

/** Compact action button matching Trellis task card actions. */
export function TaskCardActionButton(props: {
  children: JSX.Element
  onClick: (event: MouseEvent) => void
  disabled?: boolean
  danger?: boolean
  icon?: IconName
}): JSX.Element {
  return (
    <button
      type="button"
      class="flex items-center gap-1 rounded-md border px-2 py-1 text-12-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      classList={{
        "border-border-weak-base bg-background-base text-text-base hover:bg-surface-base-hover": !props.danger,
      }}
      style={
        props.danger
          ? {
              "background-color": "color-mix(in srgb, var(--surface-critical-base) 68%, var(--background-base))",
              "border-color": "color-mix(in srgb, var(--surface-critical-base) 72%, var(--background-base))",
              color: "var(--text-on-critical-base)",
            }
          : undefined
      }
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation()
        props.onClick(event)
      }}
    >
      <Show when={props.icon}>{(name) => <Icon name={name()} size="small" />}</Show>
      {props.children}
    </button>
  )
}
