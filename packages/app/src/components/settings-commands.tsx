import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { showToast } from "@opencode-ai/ui/toast"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createQuery } from "@tanstack/solid-query"
import { Component, createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsList } from "./settings-list"
import type { Agent } from "@opencode-ai/sdk/v2/client"

type CommandConfig = {
  template: string
  description?: string
  agent?: string
  model?: string
  subtask?: boolean
}

type EditFormState = {
  name: string
  template: string
  description: string
  agent: string
  model: string
  subtask: boolean
}

export const SettingsCommands: Component = () => {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const dialog = useDialog()

  const commands = createMemo(() => {
    const config = globalSync.data.config.command ?? {}
    return Object.entries(config)
      .map(([name, cmd]) => ({ name, ...(cmd as CommandConfig) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const agentsQuery = createQuery(() => ({
    queryKey: ["settings", "agents"] as const,
    queryFn: async () => {
      const result = await globalSDK.client.app.agents()
      return (result.data ?? []) as Agent[]
    },
    staleTime: 10000,
  }))

  const agentOptions = createMemo(() => {
    const agents = agentsQuery.data ?? []
    return agents
      .filter((a) => a.mode === "primary" || a.mode === "all")
      .map((a) => ({ value: a.name, label: a.name }))
  })

  const removeCommand = async (name: string) => {
    const current = globalSync.data.config.command ?? {}
    const next: Record<string, CommandConfig> = {}
    for (const [k, v] of Object.entries(current)) {
      if (k !== name) next[k] = v as CommandConfig
    }
    try {
      await globalSync.updateConfig({ command: next })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.commands.toast.removed"),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.commands.toast.error"), description: message })
    }
  }

  const openEditor = (existing?: { name: string } & CommandConfig) => {
    dialog.show(() => (
      <DialogEditCommand
        existing={existing}
        agentOptions={agentOptions()}
      />
    ))
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <div class="flex items-center justify-between">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.commands.title")}</h2>
            <Button
              size="small"
              variant="secondary"
              icon="plus-small"
              onClick={() => openEditor()}
            >
              {language.t("settings.commands.add")}
            </Button>
          </div>
          <p class="text-12-regular text-text-weak">{language.t("settings.commands.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <SettingsList>
          <Show
            when={commands().length > 0}
            fallback={
              <div class="py-4 text-14-regular text-text-weak">{language.t("settings.commands.empty")}</div>
            }
          >
            <For each={commands()}>
              {(cmd) => (
                <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-14-medium text-text-strong truncate">/{cmd.name}</span>
                      <Show when={cmd.agent}>
                        <span class="text-11-regular text-text-weaker px-1.5 py-0.5 rounded bg-surface-base-hover">
                          {cmd.agent}
                        </span>
                      </Show>
                      <Show when={cmd.subtask}>
                        <span class="text-11-regular text-text-weaker px-1.5 py-0.5 rounded bg-surface-base-hover">
                          subtask
                        </span>
                      </Show>
                    </div>
                    <Show when={cmd.description}>
                      <span class="text-12-regular text-text-weak truncate">{cmd.description}</span>
                    </Show>
                    <Show when={cmd.template}>
                      <span class="text-11-regular text-text-weaker truncate font-mono">{cmd.template}</span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-1">
                    <IconButton
                      icon="pencil-line"
                      size="small"
                      variant="ghost"
                      class="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => openEditor(cmd)}
                    />
                    <IconButton
                      icon="trash"
                      size="small"
                      variant="ghost"
                      class="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeCommand(cmd.name)}
                    />
                  </div>
                </div>
              )}
            </For>
          </Show>
        </SettingsList>
      </div>
    </div>
  )
}

function DialogEditCommand(props: {
  existing?: { name: string } & CommandConfig
  agentOptions: { value: string; label: string }[]
}) {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const dialog = useDialog()

  const isEdit = !!props.existing

  const [form, setForm] = createStore<EditFormState>({
    name: props.existing?.name ?? "",
    template: props.existing?.template ?? "",
    description: props.existing?.description ?? "",
    agent: props.existing?.agent ?? "",
    model: props.existing?.model ?? "",
    subtask: props.existing?.subtask ?? false,
  })

  const [saving, setSaving] = createSignal(false)

  const agentOptionsWithNone = createMemo(() => [
    { value: "", label: "—" },
    ...props.agentOptions,
  ])

  const save = async () => {
    const name = form.name.trim().replace(/^\//, "")
    if (!name || !form.template.trim()) return
    setSaving(true)
    try {
      const cmd: CommandConfig = {
        template: form.template.trim(),
      }
      if (form.description.trim()) cmd.description = form.description.trim()
      if (form.agent) cmd.agent = form.agent
      if (form.model.trim()) cmd.model = form.model.trim()
      if (form.subtask) cmd.subtask = true

      const current = globalSync.data.config.command ?? {}

      // If editing and name changed, remove old entry
      if (isEdit && props.existing!.name !== name) {
        const next: Record<string, CommandConfig> = {}
        for (const [k, v] of Object.entries(current)) {
          if (k !== props.existing!.name) next[k] = v as CommandConfig
        }
        next[name] = cmd
        await globalSync.updateConfig({ command: next })
      } else {
        await globalSync.updateConfig({
          command: { ...current, [name]: cmd },
        })
      }

      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.commands.toast.saved"),
      })
      dialog.close()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.commands.toast.error"), description: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={language.t(isEdit ? "settings.commands.dialog.edit.title" : "settings.commands.dialog.add.title")}>
      <div class="flex flex-col gap-4 p-2">
        <TextField
          label={language.t("settings.commands.field.name")}
          placeholder="my-command"
          value={form.name}
          onChange={(v) => setForm("name", v ?? "")}
          disabled={isEdit}
        />

        <TextField
          label={language.t("settings.commands.field.template")}
          placeholder="Review the current code changes and suggest improvements..."
          value={form.template}
          onChange={(v) => setForm("template", v ?? "")}
          multiline
          rows={4}
        />

        <TextField
          label={language.t("settings.commands.field.description")}
          placeholder="Review and improve code"
          value={form.description}
          onChange={(v) => setForm("description", v ?? "")}
        />

        <div class="flex flex-col gap-1">
          <span class="text-12-medium text-text-base">{language.t("settings.commands.field.agent")}</span>
          <Select
            options={agentOptionsWithNone()}
            current={agentOptionsWithNone().find((o) => o.value === form.agent)}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(o) => o && setForm("agent", o.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </div>

        <TextField
          label={language.t("settings.commands.field.model")}
          placeholder="anthropic/claude-sonnet-4-20250514"
          value={form.model}
          onChange={(v) => setForm("model", v ?? "")}
        />

        <div class="flex items-center justify-between py-2">
          <span class="text-14-medium text-text-strong">{language.t("settings.commands.field.subtask")}</span>
          <Switch
            checked={form.subtask}
            onChange={(checked) => setForm("subtask", checked)}
          />
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={saving() || !form.name.trim() || !form.template.trim()}
          >
            {saving() ? language.t("common.loading.ellipsis") : language.t("common.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
