import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Select } from "@opencode-ai/ui/select"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation, createQuery } from "@tanstack/solid-query"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch } from "@opencode-ai/ui/switch"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Component, createMemo, createSignal, For, Match, Show, Switch as SolidSwitch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { SettingsList } from "./settings-list"
import type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk/v2/client"

type McpEntry = McpLocalConfig | McpRemoteConfig | { enabled: boolean }

type AddFormState = {
  name: string
  type: "local" | "remote"
  command: string
  url: string
  environment: string
  headers: string
  enabled: boolean
}

const statusColor: Record<string, string> = {
  connected: "text-green-500",
  failed: "text-red-500",
  needs_auth: "text-yellow-500",
  disabled: "text-text-weak",
}

export const SettingsMcp: Component = () => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()

  const statusQuery = createQuery(() => ({
    queryKey: ["settings", "mcp", "status"] as const,
    queryFn: async () => {
      const result = await globalSDK.client.mcp.status()
      return (result.data ?? {}) as Record<string, McpStatus>
    },
    staleTime: 5000,
  }))

  const servers = createMemo(() => {
    const config = globalSync.data.config.mcp ?? {}
    const status = statusQuery.data ?? {}
    return Object.entries(config)
      .map(([name, entry]) => {
        const s = status[name]
        const entryType = "type" in entry ? entry.type : "unknown"
        return {
          name,
          type: entryType,
          status: s?.status ?? "disabled",
          error: s?.status === "failed" ? s.error : undefined,
          config: entry as McpEntry,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  const toggle = useMutation(() => ({
    mutationFn: async (name: string) => {
      const status = statusQuery.data?.[name]
      if (status?.status === "connected") {
        await globalSDK.client.mcp.disconnect({ name })
      } else {
        await globalSDK.client.mcp.connect({ name })
      }
      await statusQuery.refetch()
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.mcp.toast.error"), description: message })
    },
  }))

  const removeServer = useMutation(() => ({
    mutationFn: async (name: string) => {
      const current = globalSync.data.config.mcp ?? {}
      const next: Record<string, McpEntry> = {}
      for (const [k, v] of Object.entries(current)) {
        if (k !== name) next[k] = v
      }
      await globalSync.updateConfig({ mcp: next })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.mcp.toast.removed"),
      })
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.mcp.toast.error"), description: message })
    },
  }))

  const statusLabel = (status: string) => {
    const key = `settings.mcp.status.${status}` as const
    return language.t(key)
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <div class="flex items-center justify-between">
            <h2 class="text-16-medium text-text-strong">{language.t("settings.mcp.title")}</h2>
            <Button
              size="small"
              variant="secondary"
              icon="plus-small"
              onClick={() => dialog.show(() => <DialogAddMcp />)}
            >
              {language.t("settings.mcp.add")}
            </Button>
          </div>
          <p class="text-12-regular text-text-weak">{language.t("settings.mcp.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <SettingsList>
          <Show
            when={servers().length > 0}
            fallback={
              <div class="py-4 text-14-regular text-text-weak">{language.t("settings.mcp.empty")}</div>
            }
          >
            <For each={servers()}>
              {(server) => (
                <div class="group flex flex-wrap items-center justify-between gap-4 min-h-16 py-3 border-b border-border-weak-base last:border-none">
                  <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div class="flex items-center gap-2">
                      <span class="text-14-medium text-text-strong truncate">{server.name}</span>
                      <span class="text-11-regular text-text-weaker px-1.5 py-0.5 rounded bg-surface-base-hover">
                        {server.type === "local"
                          ? language.t("settings.mcp.type.local")
                          : language.t("settings.mcp.type.remote")}
                      </span>
                      <Show when={server.status}>
                        <span class={`text-11-regular ${statusColor[server.status] ?? "text-text-weak"}`}>
                          {statusLabel(server.status)}
                        </span>
                      </Show>
                    </div>
                    <Show when={server.error}>
                      <span class="text-11-regular text-red-500 truncate">{server.error}</span>
                    </Show>
                    <Show when={"command" in server.config && server.config.command}>
                      <span class="text-11-regular text-text-weaker truncate font-mono">
                        {(server.config as McpLocalConfig).command.join(" ")}
                      </span>
                    </Show>
                    <Show when={"url" in server.config && server.config.url}>
                      <span class="text-11-regular text-text-weaker truncate font-mono">
                        {(server.config as McpRemoteConfig).url}
                      </span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-2">
                    <div onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={server.status === "connected"}
                        disabled={toggle.isPending}
                        onChange={() => {
                          if (toggle.isPending) return
                          toggle.mutate(server.name)
                        }}
                      />
                    </div>
                    <IconButton
                      icon="trash"
                      size="small"
                      variant="ghost"
                      class="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => removeServer.mutate(server.name)}
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

function DialogAddMcp() {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const dialog = useDialog()

  const [form, setForm] = createStore<AddFormState>({
    name: "",
    type: "local",
    command: "",
    url: "",
    environment: "",
    headers: "",
    enabled: true,
  })

  const [saving, setSaving] = createSignal(false)

  const typeOptions = createMemo(() => [
    { value: "local" as const, label: language.t("settings.mcp.type.local") },
    { value: "remote" as const, label: language.t("settings.mcp.type.remote") },
  ])

  const parseKeyValue = (text: string): Record<string, string> | undefined => {
    if (!text.trim()) return undefined
    const result: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf("=")
      if (eq <= 0) continue
      result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  const save = async () => {
    if (!form.name.trim()) return
    setSaving(true)
    try {
      let config: McpLocalConfig | McpRemoteConfig
      if (form.type === "local") {
        const parts = form.command.trim().split(/\s+/).filter(Boolean)
        if (parts.length === 0) return
        config = {
          type: "local",
          command: parts,
          enabled: form.enabled,
        }
        const env = parseKeyValue(form.environment)
        if (env) config.environment = env
      } else {
        if (!form.url.trim()) return
        config = {
          type: "remote",
          url: form.url.trim(),
          enabled: form.enabled,
        }
        const headers = parseKeyValue(form.headers)
        if (headers) config.headers = headers
      }

      await globalSDK.client.mcp.add({ name: form.name.trim(), config })

      // Also persist to global config
      const current = globalSync.data.config.mcp ?? {}
      await globalSync.updateConfig({
        mcp: { ...current, [form.name.trim()]: config },
      })

      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.mcp.toast.added"),
      })
      dialog.close()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.mcp.toast.error"), description: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog title={language.t("settings.mcp.dialog.add.title")}>
      <div class="flex flex-col gap-4 p-2">
        <TextField
          label={language.t("settings.mcp.field.name")}
          placeholder="my-server"
          value={form.name}
          onChange={(v) => setForm("name", v ?? "")}
        />

        <div class="flex flex-col gap-1">
          <span class="text-12-medium text-text-base">Type</span>
          <Select
            options={typeOptions()}
            current={typeOptions().find((o) => o.value === form.type)}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(o) => o && setForm("type", o.value)}
            variant="secondary"
            size="small"
            triggerVariant="settings"
          />
        </div>

        <SolidSwitch>
          <Match when={form.type === "local"}>
            <TextField
              label={language.t("settings.mcp.field.command")}
              placeholder="npx -y @modelcontextprotocol/server-filesystem /path"
              value={form.command}
              onChange={(v) => setForm("command", v ?? "")}
            />
            <TextField
              label={language.t("settings.mcp.field.environment")}
              placeholder={"KEY=value\nKEY2=value2"}
              value={form.environment}
              onChange={(v) => setForm("environment", v ?? "")}
              multiline
              rows={3}
            />
          </Match>
          <Match when={form.type === "remote"}>
            <TextField
              label={language.t("settings.mcp.field.url")}
              placeholder="https://mcp.example.com/sse"
              value={form.url}
              onChange={(v) => setForm("url", v ?? "")}
            />
            <TextField
              label={language.t("settings.mcp.field.headers")}
              placeholder={"Authorization=Bearer token\nX-Custom=value"}
              value={form.headers}
              onChange={(v) => setForm("headers", v ?? "")}
              multiline
              rows={3}
            />
          </Match>
        </SolidSwitch>

        <div class="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={save} disabled={saving() || !form.name.trim()}>
            {saving() ? language.t("common.loading.ellipsis") : language.t("settings.mcp.add")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
