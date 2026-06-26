import { createQuery, useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { showToast } from "@opencode-ai/ui/toast"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch } from "@opencode-ai/ui/switch"
import { Select } from "@opencode-ai/ui/select"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Component, createMemo, createSignal, For, Match, Show, Switch as SolidSwitch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
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

export const ConfigMcpPanel: Component = () => {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const dialog = useDialog()

  const statusQuery = createQuery(() => ({
    queryKey: ["config", "mcp", "status"] as const,
    queryFn: async () => {
      const result = await globalSDK.client.mcp.status()
      return (result.data ?? {}) as Record<string, McpStatus>
    },
    staleTime: 5000,
  }))

  const servers = createMemo(() => {
    const config = globalSync.data.config.mcp ?? {}
    const dirMcp = sync.data.mcp ?? {}
    const allNames = new Set([...Object.keys(config), ...Object.keys(dirMcp)])
    return Array.from(allNames)
      .map((name) => {
        const s = dirMcp[name]
        const entry = config[name] as McpEntry | undefined
        const entryType = entry && "type" in entry ? (entry as McpLocalConfig | McpRemoteConfig).type : "unknown"
        const detail = entry
          ? entryType === "local"
            ? ((entry as McpLocalConfig).command ?? []).join(" ")
            : entryType === "remote"
              ? (entry as McpRemoteConfig).url ?? ""
              : ""
          : ""
        return {
          name,
          type: entryType,
          detail,
          status: s?.status ?? "disabled",
          error: s?.status === "failed" ? (s as { error?: string }).error : undefined,
          config: entry ?? ({ enabled: true } as McpEntry),
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
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex items-center justify-between border-b border-border-weak-base px-6 py-4">
        <div class="text-15-medium text-text-strong">{language.t("config.mcp.title")}</div>
        <Button
          size="small"
          variant="ghost"
          icon="plus-small"
          class="h-8 rounded-lg border border-border-weak-base bg-background-base px-2.5 pr-3 text-12-medium text-text-base shadow-none transition-colors hover:border-border-strong hover:bg-surface-base-hover active:border-border-base active:bg-surface-base-active"
          onClick={() => dialog.show(() => <DialogAddMcpConfig />)}
        >
          {language.t("config.mcp.add")}
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <Show
          when={servers().length > 0}
          fallback={
            <div class="flex h-full items-center justify-center py-16">
              <div class="text-13-regular text-text-weak">{language.t("config.mcp.empty")}</div>
            </div>
          }
        >
          <div class="flex flex-col gap-3">
            <For each={servers()}>
              {(server) => (
                <div class="group flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-weak-base bg-surface-base px-4 py-3">
                  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div class="flex items-center gap-2">
                      <span class="text-14-medium text-text-strong truncate">{server.name}</span>
                      <span class="rounded bg-surface-base-hover px-1.5 py-0.5 text-11-regular text-text-weaker">
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
                      <span class="truncate text-11-regular text-red-500">{server.error}</span>
                    </Show>
                    <Show when={server.detail}>
                      <span class="truncate font-mono text-11-regular text-text-weaker">
                        {server.detail}
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
                      class="opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={() => removeServer.mutate(server.name)}
                    />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

function DialogAddMcpConfig() {
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
