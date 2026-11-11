import { Component, Index, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { useExtensionHost } from "@/extensions/host"
import type { ExtensionInfo, SettingDefinition } from "@/extensions/types"
import { SettingsList } from "@/components/settings-list"
import {
  buildSettingsPatch,
  enumDraftOptions,
  initialDraft,
  secretConfigured,
  type SettingDraft,
} from "@/components/settings-extensions-utils"

// Only the shared settings labels are needed by the form.
export type ConfigExtensionSettingsLanguage = {
  t: (
    key:
      | "settings.extensions.toast.saved"
      | "settings.extensions.toast.failed"
      | "settings.extensions.save"
      | "settings.extensions.saving"
      | "settings.extensions.enum.unset"
      | "settings.extensions.secret.hint"
      | "common.cancel",
  ) => string
}

// Persists one extension's settings patch and resolves with the authoritative
// masked snapshot (the ExtensionHost bridge in production).
export type SaveExtensionSettings = (id: string, patch: Record<string, unknown>) => Promise<ExtensionInfo>

export interface ConfigExtensionSettingsProps {
  item: ExtensionInfo
  disabled?: boolean
  hideHeading?: boolean
  onStateChange?: (state: { dirty: boolean; saving: boolean }) => void
  // Test seams: production callers omit both and the language context plus
  // the ExtensionHost bridge are used instead. Optional so the real production
  // wiring stays the default path.
  language?: ConfigExtensionSettingsLanguage
  saveSettings?: SaveExtensionSettings
}

// Settings section for a single extension that contributes settings
// definitions through its manifest. Values are edited as drafts and PATCHed
// through the ExtensionHost bridge on save; the server answers with the
// authoritative masked snapshot, which becomes the new baseline. The parent
// owns the list and keys sections by extension id.
export const ConfigExtensionSettings: Component<ConfigExtensionSettingsProps> = (props) => {
  const language = props.language ?? useLanguage()
  const host = props.saveSettings ? undefined : useExtensionHost()
  const saveSettings = props.saveSettings ?? ((id, patch) => host!.updateSettings(id, patch))

  const definitions = createMemo(() => props.item.contributes.settings ?? {})
  const keys = createMemo(() => Object.keys(definitions()))

  const [draft, setDraft] = createStore<SettingDraft>(initialDraft(definitions(), props.item.settings))
  const [touched, setTouched] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [saving, setSaving] = createSignal(false)
  // An in-flight save must not write drafts or toast into a disposed section
  // (the parent unmounts it when the extension list changes).
  let alive = true
  onCleanup(() => {
    alive = false
    props.onStateChange?.({ dirty: false, saving: false })
  })

  const patch = createMemo(() => buildSettingsPatch(definitions(), props.item.settings, draft, touched()))
  const dirty = createMemo(() => {
    if (patch()) return true
    const baseline = initialDraft(definitions(), props.item.settings)
    return keys().some((key) => draft[key] !== baseline[key])
  })
  createEffect(() => props.onStateChange?.({ dirty: dirty(), saving: saving() }))

  // The server snapshot is the source of truth: whenever the host replaces the
  // manifest (save response, refresh after status events), local edits are
  // discarded and the form re-baselines. This keeps a stale draft from
  // silently reverting a change made elsewhere.
  createEffect(
    on(
      () => props.item.settings,
      () => {
        setDraft(reconcile(initialDraft(definitions(), props.item.settings)))
        setTouched(new Set<string>())
      },
    ),
  )

  const edit = (key: string, value: string | boolean) => {
    setTouched((current) => touch(current, key))
    setDraft(key, value)
  }

  const save = async () => {
    const current = patch()
    if (!current || saving() || props.disabled) return
    // Capture the identity of the extension being saved: props.item can be
    // swapped for another extension while the request is in flight, and the
    // response (and toast) belongs to the captured one, never to the
    // extension that happens to be rendered when it resolves.
    const id = props.item.id
    const displayName = props.item.displayName
    const snapshot = definitions()
    setSaving(true)
    try {
      const fresh = await saveSettings(id, current)
      console.debug(`[config-extension-settings] saved id=${id} keys=${Object.keys(current).length}`)
      if (!alive || props.item.id !== id) {
        console.debug(`[config-extension-settings] save resolved stale from=${id} to=${props.item.id}`)
        return
      }
      setDraft(reconcile(initialDraft(snapshot, fresh.settings)))
      setTouched(new Set<string>())
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.extensions.toast.saved"),
        description: displayName,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[config-extension-settings] save failed id=${id} error=${message}`)
      if (alive) {
        showToast({
          title: language.t("settings.extensions.toast.failed"),
          description: message,
        })
      }
    } finally {
      if (alive) setSaving(false)
    }
  }

  return (
    <div class="flex flex-col gap-1 pb-2" data-extension-id={props.item.id}>
      <Show when={!props.hideHeading}>
        <div class="flex items-baseline gap-2 pt-2">
          <span class="text-14-medium text-text-strong">{props.item.displayName}</span>
          <span class="text-12-regular text-text-weak">v{props.item.version}</span>
        </div>
      </Show>
      <fieldset class="min-w-0" disabled={props.disabled || saving()}>
        <SettingsList>
          <Index each={keys()}>
            {(key) => (
              <SettingRow
                settingKey={key()}
                title={definitions()[key()].title || key()}
                definition={definitions()[key()]}
                stored={props.item.settings?.[key()]}
                draft={draft[key()]}
                onEdit={(value) => edit(key(), value)}
                language={language}
              />
            )}
          </Index>
          <div class="flex justify-end gap-2 pt-4">
            <Button
              data-action="extension-settings-discard"
              size="small"
              variant="ghost"
              disabled={!dirty() || saving() || props.disabled}
              onClick={() => {
                setDraft(reconcile(initialDraft(definitions(), props.item.settings)))
                setTouched(new Set<string>())
              }}
            >
              {language.t("common.cancel")}
            </Button>
            <Button
              data-action="settings-extensions-save"
              aria-label={`${language.t("settings.extensions.save")} ${props.item.displayName}`}
              size="small"
              variant="secondary"
              disabled={!patch() || saving() || props.disabled}
              onClick={() => void save()}
            >
              {saving() ? language.t("settings.extensions.saving") : language.t("settings.extensions.save")}
            </Button>
          </div>
        </SettingsList>
      </fieldset>
    </div>
  )
}

const touch = (previous: ReadonlySet<string>, key: string) => {
  const next = new Set(previous)
  next.add(key)
  return next
}

interface SettingRowProps {
  settingKey: string
  title: string
  definition: SettingDefinition
  stored: unknown
  draft: string | boolean
  onEdit: (value: string | boolean) => void
  language: ConfigExtensionSettingsLanguage
}

// Row layout mirrors SettingsRow in settings-general, but takes the manifest
// declaration instead of translated strings — extension settings carry their
// own title/description from the manifest.
const SettingRow: Component<SettingRowProps> = (props) => {
  const language = props.language
  const control = (): JSX.Element => {
    const definition = props.definition
    if (definition.type === "boolean") {
      return (
        <Switch checked={props.draft === true} aria-label={props.title} onChange={(checked) => props.onEdit(checked)} />
      )
    }
    if (Array.isArray(definition.enum)) {
      const options = enumDraftOptions(definition, language.t("settings.extensions.enum.unset"))
      return (
        <Select
          options={options}
          current={options.find((option) => option.value === props.draft)}
          value={(option) => option.value}
          label={(option) => option.label}
          onSelect={(option) => option && props.onEdit(option.value)}
          variant="secondary"
          size="small"
          triggerVariant="settings"
          triggerStyle={{ "min-width": "180px" }}
          triggerProps={{ "aria-label": props.title }}
        />
      )
    }
    if (definition.secret) {
      return (
        <TextField
          type="password"
          autocomplete="off"
          aria-label={props.title}
          value={typeof props.draft === "string" ? props.draft : ""}
          placeholder={secretConfigured(props.stored) ? "••••••••" : undefined}
          description={language.t("settings.extensions.secret.hint")}
          onChange={(value) => props.onEdit(value)}
        />
      )
    }
    if (definition.type === "number") {
      return (
        <TextField
          type="number"
          aria-label={props.title}
          value={typeof props.draft === "string" ? props.draft : ""}
          onChange={(value) => props.onEdit(value)}
        />
      )
    }
    return (
      <TextField
        aria-label={props.title}
        value={typeof props.draft === "string" ? props.draft : ""}
        onChange={(value) => props.onEdit(value)}
      />
    )
  }

  return (
    <div
      class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap"
      data-setting-key={props.settingKey}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <Show when={props.definition.description}>
          <span class="text-12-regular text-text-weak">{props.definition.description}</span>
        </Show>
      </div>
      <div class="flex w-full justify-end sm:w-1/2 sm:max-w-xl sm:shrink-0">{control()}</div>
    </div>
  )
}
