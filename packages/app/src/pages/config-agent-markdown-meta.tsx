import { createMemo, For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ModelSelectorPopover, useBoundModelState } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import {
  parseAgentMarkdown,
  type AgentPermissionCapsule,
} from "./config-agent-markdown"

export function AgentMarkdownMeta(props: {
  text: string
  editable: boolean
  busy: boolean
  onModelChange: (next: string) => void
}) {
  const language = useLanguage()
  const parsed = createMemo(() => parseAgentMarkdown(props.text))
  const model = createMemo(() => parsed().model ?? "")
  const formModel = useBoundModelState({
    value: model,
    onChange: (next) => {
      const current = model()
      if (next === current) {
        console.info(`[config] agent markdown model selector unchanged model=${current}`)
        return
      }
      console.info(`[config] agent markdown model selector from=${current} to=${next}`)
      props.onModelChange(next)
    },
  })
  const selectedModel = createMemo(() => formModel.current())
  const permissions = createMemo(() => parsed().permissions)

  return (
    <div class="mt-3 flex flex-col gap-2.5" data-component="config-agent-markdown-meta">
      <div class="flex min-w-0 items-center gap-3">
        <div class="w-[88px] shrink-0 text-12-medium text-text-weak">{language.t("config.agents.field.model")}</div>
        <div class="flex min-w-0 flex-1 items-center gap-1">
          <Show
            when={props.editable}
            fallback={
              <div class="flex min-w-0 items-center gap-2 rounded-lg border border-border-weak-base bg-background-base px-3 py-2 text-13-regular text-text-strong">
                <Show when={selectedModel()?.provider?.id}>
                  <ProviderIcon id={selectedModel()!.provider.id} class="size-4 shrink-0" />
                </Show>
                <span class="truncate">
                  {selectedModel()
                    ? `${selectedModel()!.provider.name} / ${selectedModel()!.name}`
                    : model() || language.t("config.agents.field.default")}
                </span>
              </div>
            }
          >
            <ModelSelectorPopover
              model={formModel}
              triggerAs={Button}
              triggerProps={{
                type: "button",
                variant: "ghost",
                disabled: props.busy,
                "data-action": "agent-markdown-model",
                class:
                  "h-9 min-w-0 flex-1 justify-between rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong hover:border-border-strong hover:bg-surface-base-hover",
              }}
            >
              <div class="flex min-w-0 items-center gap-2">
                <Show when={selectedModel()?.provider?.id}>
                  <ProviderIcon id={selectedModel()!.provider.id} class="size-4 shrink-0" />
                </Show>
                <span class="truncate">
                  {selectedModel()
                    ? `${selectedModel()!.provider.name} / ${selectedModel()!.name}`
                    : model() || language.t("config.agents.field.default")}
                </span>
              </div>
              <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
            </ModelSelectorPopover>
            <Show when={model()}>
              <IconButton
                icon="close"
                variant="ghost"
                iconSize="small"
                class="size-9 shrink-0"
                disabled={props.busy}
                data-action="agent-markdown-model-clear"
                aria-label={language.t("config.agents.field.default")}
                onClick={() => formModel.set(undefined)}
              />
            </Show>
          </Show>
        </div>
      </div>
      <div class="flex min-w-0 items-start gap-3">
        <div class="w-[88px] shrink-0 pt-0.5 text-12-medium text-text-weak">
          {language.t("config.agents.meta.permissions")}
        </div>
        <div class="flex min-w-0 flex-1 flex-wrap gap-1.5">
          <Show
            when={permissions().length > 0}
            fallback={
              <div class="text-12-regular text-text-weak">{language.t("config.agents.meta.permissions.empty")}</div>
            }
          >
            <For each={permissions()}>
              {(item) => <PermissionCapsule item={item} />}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}

function permissionCapsuleTone(item: AgentPermissionCapsule) {
  if (!item.known || !item.validAction) return "var(--icon-critical-base)"
  if (item.action === "allow") return "var(--icon-success-base)"
  if (item.action === "ask") return "var(--icon-warning-base)"
  if (item.action === "deny") return "var(--icon-critical-base)"
  return "var(--text-weak)"
}

function permissionCapsuleStyle(tone: string) {
  return {
    color: `color-mix(in srgb, ${tone} 32%, var(--text-strong))`,
    "background-color": `color-mix(in srgb, ${tone} 16%, var(--background-base))`,
    "border-color": `color-mix(in srgb, ${tone} 34%, var(--border-weak-base))`,
  }
}

function PermissionCapsule(props: { item: AgentPermissionCapsule }) {
  const language = useLanguage()
  const actionLabel = () => {
    if (props.item.action === "allow") return language.t("settings.permissions.action.allow")
    if (props.item.action === "ask") return language.t("settings.permissions.action.ask")
    if (props.item.action === "deny") return language.t("settings.permissions.action.deny")
    return props.item.action
  }
  const permissionLabel = () => {
    if (!props.item.known) {
      return language.t("config.agents.meta.permissions.unknownTool", { name: props.item.permission })
    }
    if (props.item.permission === "*") return language.t("config.agents.meta.permissions.all")
    const key = `settings.permissions.tool.${props.item.permission}.title`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return props.item.permission
    return value
  }
  const title = () => {
    if (!props.item.known) {
      return language.t("config.agents.meta.permissions.unknownTool", { name: props.item.permission })
    }
    if (!props.item.validAction) return language.t("config.agents.meta.permissions.invalid")
    return `${props.item.permission}${props.item.pattern ? ` ${props.item.pattern}` : ""}`
  }
  const tone = () => permissionCapsuleTone(props.item)
  const dashed = () => !props.item.known || !props.item.validAction

  return (
    <span
      data-permission={props.item.permission}
      data-permission-action={props.item.action}
      data-permission-known={props.item.known ? "true" : "false"}
      data-permission-valid={props.item.validAction ? "true" : "false"}
      title={title()}
      class="text-12-medium inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5"
      classList={{
        "border-dashed": dashed(),
      }}
      style={permissionCapsuleStyle(tone())}
    >
      <span class="truncate">
        {permissionLabel()}
        <Show when={props.item.known && props.item.pattern}>
          {(pattern) => <span class="text-[10px] opacity-70">{` ${pattern()}`}</span>}
        </Show>
      </span>
      <Show when={props.item.known}>
        <span class="opacity-40">·</span>
        <span>{actionLabel()}</span>
      </Show>
    </span>
  )
}
