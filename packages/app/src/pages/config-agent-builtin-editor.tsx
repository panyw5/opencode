import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { Agent, Config } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Markdown } from "@opencode-ai/ui/markdown"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { ModelSelectorPopover, useBoundModelState } from "@/components/dialog-select-model"
import { useLanguage } from "@/context/language"
import { KNOWN_AGENT_PERMISSION_KEYS } from "./config-agent-markdown"
import { permissionCapsuleStyle, permissionCapsuleTone } from "./config-agent-markdown-meta"

export type BuiltInAgentForm = {
  model: string
  permission: Record<string, unknown>
}

export function builtinAgentForm(config: NonNullable<Config["agent"]>[string] | undefined): BuiltInAgentForm {
  return {
    model: typeof config?.model === "string" ? config.model : "",
    permission: normalizePermissionOverride(config?.permission),
  }
}

function normalizePermissionOverride(permission: unknown): Record<string, unknown> {
  if (typeof permission === "string") return { "*": permission }
  if (permission && typeof permission === "object" && !Array.isArray(permission)) {
    return { ...(permission as Record<string, unknown>) }
  }
  return {}
}

const PERMISSION_CYCLE = ["allow", "ask", "deny"] as const

function nextPermissionAction(current: string | undefined): string | undefined {
  if (!current) return PERMISSION_CYCLE[0]
  const index = PERMISSION_CYCLE.indexOf(current as (typeof PERMISSION_CYCLE)[number])
  if (index === -1 || index === PERMISSION_CYCLE.length - 1) return undefined
  return PERMISSION_CYCLE[index + 1]
}

type BuiltinPermissionCapsule = {
  key: string
  known: boolean
  /** Explicit string override from opencode.jsonc. */
  override?: string
  /** Inherited built-in key-level action (from `*` pattern rules). */
  defaultAction?: string
  /** Deduped non-`*` runtime rules shown as a count in the capsule and detailed in its tooltip. */
  patterns: { pattern: string; action: string }[]
  /** Entries of an object-shaped override (hand-written pattern rules in opencode.jsonc). */
  overridePatterns: { pattern: string; action: string }[]
  editable: boolean
  /**
   * Internal permission keys (unknown to the UI, never overridden, no pattern rules)
   * are folded into a single summary capsule to keep the list readable.
   */
  collapsed: boolean
}

function builtinPermissionCapsules(
  override: Record<string, unknown>,
  rules: Agent["permission"] | undefined,
): BuiltinPermissionCapsule[] {
  const ruleList = rules ?? []
  const keys = new Set<string>(Object.keys(override))
  for (const rule of ruleList) keys.add(rule.permission)
  const ordered = [...keys].sort((a, b) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b)))

  return ordered.map((key) => {
    const entry = override[key]
    const keyRules = ruleList.filter((rule) => rule.permission === key)
    const seen = new Set<string>()
    const patterns: { pattern: string; action: string }[] = []
    for (const rule of keyRules) {
      if (!rule.pattern || rule.pattern === "*") continue
      const id = `${rule.pattern}:${rule.action}`
      if (seen.has(id)) continue
      seen.add(id)
      patterns.push({ pattern: rule.pattern, action: rule.action })
    }
    const starActions = [
      ...new Set(keyRules.filter((rule) => !rule.pattern || rule.pattern === "*").map((rule) => rule.action)),
    ]
    const overrideString = typeof entry === "string" ? entry : undefined
    const overridePatterns: { pattern: string; action: string }[] = []
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const [pattern, action] of Object.entries(entry as Record<string, unknown>)) {
        overridePatterns.push({ pattern, action: typeof action === "string" ? action : String(action ?? "") })
      }
    }
    const known = KNOWN_AGENT_PERMISSION_KEYS.has(key)
    return {
      key,
      known,
      override: overrideString,
      defaultAction: starActions.length === 1 ? starActions[0] : undefined,
      patterns,
      overridePatterns,
      editable:
        (entry === undefined || typeof entry === "string") && patterns.length === 0 && overridePatterns.length === 0,
      collapsed: !known && overrideString === undefined && overridePatterns.length === 0 && patterns.length === 0,
    } satisfies BuiltinPermissionCapsule
  })
}

function ruleDetailsTitle(t: ReturnType<typeof useLanguage>["t"], item: BuiltinPermissionCapsule) {
  const lines: string[] = []
  if (item.defaultAction) lines.push(`* → ${item.defaultAction}`)
  for (const rule of item.overridePatterns) lines.push(`${rule.pattern} → ${rule.action}`)
  for (const rule of item.patterns) lines.push(`${rule.pattern} → ${rule.action}`)
  if (item.patterns.length > 0 || item.overridePatterns.length > 0) {
    lines.push(t("config.agents.meta.permissions.patternLocked"))
  }
  return lines.join("\n")
}

/**
 * Editor for built-in agents (build/plan/general/...).
 * Their source of truth is the runtime, so only `model` and `permission`
 * overrides are editable here; both are written to `agent.<name>` in the
 * global opencode.jsonc via props.onSave.
 */
export function BuiltInAgentEditor(props: {
  name: string
  config?: NonNullable<Config["agent"]>[string]
  runtime?: Agent
  onSave: (form: BuiltInAgentForm) => Promise<void>
}) {
  const language = useLanguage()
  const t = language.t
  const [form, setForm] = createStore<BuiltInAgentForm>(builtinAgentForm(props.config))
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")

  const formModel = useBoundModelState({
    value: () => form.model,
    onChange: (next) => setForm("model", next),
  })
  const selectedModel = createMemo(() => formModel.current())
  const runtimeModelRef = createMemo(() => {
    const model = props.runtime?.model
    return model ? `${model.providerID}/${model.modelID}` : ""
  })
  const overridden = createMemo(() => {
    const config = props.config
    if (!config) return false
    return Object.keys(config).length > 0
  })
  const allCapsules = createMemo(() => builtinPermissionCapsules(form.permission, props.runtime?.permission))
  const capsules = createMemo(() => allCapsules().filter((item) => !item.collapsed))
  const collapsedCapsules = createMemo(() => allCapsules().filter((item) => item.collapsed))
  const prompt = createMemo(() => {
    if (typeof props.config?.prompt === "string" && props.config.prompt.trim()) return props.config.prompt
    return props.runtime?.prompt ?? ""
  })

  createEffect(
    on(
      () => [props.name, props.config] as const,
      ([, config]) => {
        setForm(builtinAgentForm(config))
        setError("")
      },
      { defer: false },
    ),
  )

  function cyclePermission(key: string) {
    const entry = form.permission[key]
    const next = nextPermissionAction(typeof entry === "string" ? entry : undefined)
    console.info("[config] builtin agent permission cycled", { name: props.name, permission: key, next: next ?? "default" })
    setForm("permission", key, next)
  }

  async function save() {
    setSaving(true)
    setError("")
    try {
      await props.onSave({ model: form.model, permission: { ...form.permission } })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-5 py-4">
        <div>
          <div class="flex items-center gap-2">
            <div class="text-20-medium text-text-strong">{props.name}</div>
            <span class="rounded-full bg-surface-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-weak">
              opencode.jsonc
            </span>
            <Show when={overridden()}>
              <span
                class="rounded-full border border-border-weak-base bg-surface-secondary px-1.5 py-0.5 text-[10px] text-text-weak"
                data-action="builtin-agent-overridden"
              >
                {t("config.agents.builtin.overridden")}
              </span>
            </Show>
          </div>
          <div class="mt-1 text-12-regular text-text-weak">{t("config.agents.builtin.description")}</div>
        </div>
        <SaveButton label={saving() ? t("config.agents.jsonc.saving") : t("common.save")} onClick={() => void save()} disabled={saving()} />
      </div>
      <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
        <div class="mx-auto flex max-w-[920px] flex-col gap-6">
          <Show when={error()}>
            {(message) => <div class="text-12-regular text-text-danger-base">{message()}</div>}
          </Show>
          <div class="grid gap-4 md:grid-cols-2">
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{t("config.agents.field.model")}</label>
              <div class="flex min-w-0 items-center gap-1">
                <ModelSelectorPopover
                  model={formModel}
                  triggerAs={Button}
                  triggerProps={{
                    type: "button",
                    variant: "ghost",
                    "data-action": "builtin-agent-model",
                    class:
                      "h-10 min-w-0 flex-1 justify-between rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong hover:border-border-strong hover:bg-surface-base-hover",
                  }}
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <Show when={selectedModel()?.provider?.id}>
                      <ProviderIcon id={selectedModel()!.provider.id} class="size-4 shrink-0" />
                    </Show>
                    <span class="truncate">
                      {selectedModel()
                        ? `${selectedModel()!.provider.name} / ${selectedModel()!.name}`
                        : form.model.trim() || runtimeModelRef() || t("config.agents.field.default")}
                    </span>
                  </div>
                  <Icon name="chevron-down" size="small" class="shrink-0 text-text-weak" />
                </ModelSelectorPopover>
                <Show when={form.model.trim()}>
                  <IconButton
                    icon="close"
                    variant="ghost"
                    iconSize="small"
                    class="size-10 shrink-0"
                    aria-label={t("config.agents.field.default")}
                    onClick={() => formModel.set(undefined)}
                  />
                </Show>
              </div>
              <Show when={!form.model.trim() && runtimeModelRef()}>
                <div class="text-12-regular text-text-weak">
                  {t("config.agents.field.default")}: <span class="font-mono">{runtimeModelRef()}</span>
                </div>
              </Show>
            </div>
            <div class="flex flex-col gap-2">
              <label class="text-12-medium text-text-weak">{t("config.agents.field.mode")}</label>
              <div class="flex h-10 items-center rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-weak">
                {props.runtime?.mode ?? t("config.agents.field.default")}
              </div>
            </div>
          </div>
          <div class="flex flex-col gap-2">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <label class="text-12-medium text-text-weak">{t("config.agents.meta.permissions")}</label>
              <span class="text-12-regular text-text-weak">{t("config.agents.builtin.permissionsHint")}</span>
            </div>
            <div class="flex min-w-0 flex-wrap gap-1.5">
              <For each={capsules()}>
                {(item) => <PermissionCapsuleRow item={item} onCycle={() => cyclePermission(item.key)} />}
              </For>
              <Show when={collapsedCapsules().length > 0}>
                <span
                  data-permission="__collapsed__"
                  data-permission-count={collapsedCapsules().length}
                  title={collapsedCapsules()
                    .map((item) => `${item.key} → ${item.defaultAction ?? item.override ?? "default"}`)
                    .join("\n")}
                  class="text-12-medium inline-flex max-w-full items-center gap-1 rounded-full border border-dashed px-2 py-0.5"
                  style={permissionCapsuleStyle("var(--text-weak)")}
                >
                  <span class="truncate">{t("config.agents.meta.permissions.other")}</span>
                  <span class="opacity-40">·</span>
                  <span>{collapsedCapsules().length}</span>
                </span>
              </Show>
            </div>
          </div>
          <div class="flex min-h-80 flex-col gap-2" data-component="config-agent-builtin-prompt">
            <label class="text-12-medium text-text-weak">{t("config.agents.field.prompt")}</label>
            <div class="config-scrollbar min-h-0 flex-1 overflow-y-auto rounded-xl border border-border-weak-base bg-background-base p-4">
              <Show
                when={prompt().trim()}
                fallback={
                  <div class="text-13-regular text-text-weak">{t("config.agents.builtin.prompt.empty")}</div>
                }
              >
                <Markdown text={prompt()} math="full" highlight="defer" />
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PermissionCapsuleRow(props: { item: BuiltinPermissionCapsule; onCycle: () => void }) {
  const language = useLanguage()
  const t = language.t
  const item = () => props.item
  const patternCount = () => item().patterns.length + item().overridePatterns.length
  const title = () => ruleDetailsTitle(t, item())

  return (
    <Show
      when={item().editable}
      fallback={
        <span
          data-permission={item().key}
          data-permission-action={item().override ?? item().defaultAction ?? "default"}
          data-permission-locked="true"
          title={title()}
          class="text-12-medium inline-flex max-w-full cursor-default items-center gap-1 rounded-full border px-2 py-0.5"
          classList={{ "border-dashed": !item().override }}
          style={permissionCapsuleStyle(capsuleTone(item()))}
        >
          <span class="truncate">
            {permissionKeyLabel(t, item().key)}
            <Show when={!item().override && item().defaultAction}>
              <span class="text-[10px] opacity-70">{` ${actionLabel(t, item().defaultAction)}`}</span>
            </Show>
          </span>
          <Show when={patternCount() > 0}>
            <span class="text-[10px] opacity-70">{`+${patternCount()}`}</span>
          </Show>
          <span class="opacity-40">·</span>
          <span>{item().override ? actionLabel(t, item().override) : t("config.agents.meta.permissions.default")}</span>
          <Icon name="shield" size="small" class="shrink-0 opacity-50" />
        </span>
      }
    >
      <button
        type="button"
        data-permission={item().key}
        data-permission-action={item().override ?? item().defaultAction ?? "default"}
        data-permission-override={item().override ? "true" : "false"}
        title={item().override ? actionLabel(t, item().override) : t("config.agents.meta.permissions.builtinDefault")}
        class="text-12-medium inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 transition-colors hover:opacity-80"
        classList={{ "border-dashed": !item().override }}
        style={permissionCapsuleStyle(capsuleTone(item()))}
        onClick={props.onCycle}
      >
        <span class="truncate">
          {permissionKeyLabel(t, item().key)}
          <Show when={item().defaultAction && !item().override}>
            <span class="text-[10px] opacity-70">{` ${actionLabel(t, item().defaultAction)}`}</span>
          </Show>
        </span>
        <span class="opacity-40">·</span>
        <span>{item().override ? actionLabel(t, item().override) : t("config.agents.meta.permissions.default")}</span>
      </button>
    </Show>
  )
}

function capsuleTone(item: BuiltinPermissionCapsule) {
  const action = item.override ?? item.defaultAction
  if (!action) return "var(--text-weak)"
  return permissionCapsuleTone({ id: item.key, permission: item.key, action, known: true, validAction: true })
}

function SaveButton(props: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <Button
      size="small"
      variant="secondary"
      icon="save"
      onClick={props.onClick}
      disabled={props.disabled}
      class="config-save-button"
      data-config-save-state={props.disabled ? "disabled" : "active"}
    >
      {props.label}
    </Button>
  )
}

function permissionKeyLabel(t: ReturnType<typeof useLanguage>["t"], key: string) {
  if (key === "*") return t("config.agents.meta.permissions.all")
  const i18nKey = `settings.permissions.tool.${key}.title`
  const value = t(i18nKey as Parameters<typeof t>[0])
  // Missing i18n entries resolve to undefined — fall back to the raw key name.
  if (!value || value === i18nKey) return key
  return value
}

function actionLabel(t: ReturnType<typeof useLanguage>["t"], action: string | undefined) {
  if (action === "allow") return t("settings.permissions.action.allow")
  if (action === "ask") return t("settings.permissions.action.ask")
  if (action === "deny") return t("settings.permissions.action.deny")
  return t("config.agents.meta.permissions.default")
}
