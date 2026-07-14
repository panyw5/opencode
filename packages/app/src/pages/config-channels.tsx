import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Component,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import type { ChannelConfig, ChannelDiscordConfig, ChannelFeishuConfig, Config } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
import { useModels } from "@/context/models"
import {
  beginRegistration,
  FeishuRegistrationError,
  initRegistration,
  pollRegistration,
  probeBot,
  qrSvgDataUrl,
  type FeishuDomain,
  type FeishuRegistrationSession,
} from "@/lib/feishu-app-registration"

export type ChannelPlatform = "feishu" | "discord"

export const CHANNEL_PLATFORMS: ChannelPlatform[] = ["feishu", "discord"]

export function channelPick(platform: ChannelPlatform) {
  return `channels:${platform}` as const
}

export function parseChannelPick(pick: string): ChannelPlatform | undefined {
  if (pick === "channels:feishu") return "feishu"
  if (pick === "channels:discord") return "discord"
  return undefined
}

function parseUserList(text: string): string[] | undefined {
  if (!text.trim()) return undefined
  const items = text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

function maskSecret(value: string | undefined): string {
  if (!value) return ""
  if (value.length <= 8) return "••••••••"
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

type ModelRef = { providerID: string; modelID: string }

type ModelOption = {
  value: ModelRef | undefined
  label: string
}

type ChannelRow = {
  name: string
  enabled: boolean
  summary: string
  model?: string
  config: ChannelConfig
}

function parseModelRef(raw: string | undefined): ModelRef | undefined {
  if (!raw?.trim()) return undefined
  const slash = raw.indexOf("/")
  if (slash <= 0) return undefined
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
}

function formatModelRef(ref: ModelRef | undefined): string | undefined {
  if (!ref) return undefined
  return `${ref.providerID}/${ref.modelID}`
}

export function useChannelRows(platform: () => ChannelPlatform | undefined) {
  const globalSync = useGlobalSync()
  return createMemo((): ChannelRow[] => {
    const p = platform()
    if (!p) return []
    const cfg = globalSync.data.config.channels ?? {}
    return Object.entries(cfg)
      .filter(([, entry]) => entry.type === p)
      .map(([name, entry]) => {
        const summary =
          entry.type === "feishu"
            ? entry.appId
            : maskSecret(entry.botToken)
        return {
          name,
          enabled: entry.enabled !== false,
          summary,
          model: entry.model,
          config: entry,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  })
}

export type ChannelMiddleItem = {
  platform: ChannelPlatform
  pick: string
  title: string
  note: string
  count: number
  active: boolean
}

export function useChannelMiddleItems(pick: () => string): () => ChannelMiddleItem[] {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  return createMemo(() => {
    const cfg = globalSync.data.config.channels ?? {}
    let feishu = 0
    let discord = 0
    for (const entry of Object.values(cfg)) {
      if (entry.type === "feishu") feishu++
      if (entry.type === "discord") discord++
    }
    const current = pick()
    return [
      {
        platform: "feishu" as const,
        pick: channelPick("feishu"),
        title: language.t("config.channels.platform.feishu"),
        note: language.t("config.channels.platform.feishu.note"),
        count: feishu,
        active: current === channelPick("feishu"),
      },
      {
        platform: "discord" as const,
        pick: channelPick("discord"),
        title: language.t("config.channels.platform.discord"),
        note: language.t("config.channels.platform.discord.note"),
        count: discord,
        active: current === channelPick("discord"),
      },
    ]
  })
}

export const ConfigChannelsDetail: Component<{
  platform: ChannelPlatform
}> = (props) => {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  const models = useModels()
  const rows = useChannelRows(() => props.platform)

  const modelAuto: ModelOption = {
    value: undefined,
    label: language.t("config.channels.field.model.auto"),
  }

  const modelOptions = createMemo((): ModelOption[] => {
    const list = models
      .list()
      .map((item) => ({
        value: { providerID: item.provider.id, modelID: item.id } satisfies ModelRef,
        label: `${item.provider.name} - ${item.name}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
    return [modelAuto, ...list]
  })

  const [form, setForm] = createStore({
    name: "",
    enabled: true,
    appId: "",
    appSecret: "",
    domain: "feishu" as FeishuDomain,
    botToken: "",
    proxy: "",
    allowedUsers: "",
    model: "" as string,
    mode: "qr" as "qr" | "manual",
  })
  const [saving, setSaving] = createSignal(false)
  const [qrStatus, setQrStatus] = createSignal<"idle" | "loading" | "waiting" | "success" | "error">("idle")
  const [qrSession, setQrSession] = createSignal<FeishuRegistrationSession | null>(null)
  const [qrError, setQrError] = createSignal("")
  const [qrImage, setQrImage] = createSignal("")
  const [botLabel, setBotLabel] = createSignal("")

  let abort: AbortController | null = null
  const stopQr = () => {
    abort?.abort()
    abort = null
  }
  onCleanup(() => stopQr())

  // Reset form when switching platform
  createEffect(() => {
    const p = props.platform
    stopQr()
    setForm({
      name: "",
      enabled: true,
      appId: "",
      appSecret: "",
      domain: "feishu",
      botToken: "",
      proxy: "",
      allowedUsers: "",
      model: "",
      mode: p === "feishu" ? "qr" : "manual",
    })
    setQrStatus("idle")
    setQrError("")
    setQrSession(null)
    setQrImage("")
    setBotLabel("")
  })

  const startQr = async () => {
    stopQr()
    abort = new AbortController()
    const signal = abort.signal
    setQrStatus("loading")
    setQrError("")
    setQrSession(null)
    setQrImage("")
    setBotLabel("")
    try {
      await initRegistration(form.domain, signal)
      const session = await beginRegistration(form.domain, signal)
      setQrSession(session)
      if (session.qrUrl) {
        try {
          setQrImage(qrSvgDataUrl(session.qrUrl, 200))
        } catch {
          setQrImage("")
        }
      }
      setQrStatus("waiting")
      const creds = await pollRegistration(session, { signal, timeoutMs: session.expireInMs })
      setForm("appId", creds.appId)
      setForm("appSecret", creds.appSecret)
      setForm("domain", creds.domain)
      if (creds.openId) setForm("allowedUsers", creds.openId)
      const bot = await probeBot(creds.appId, creds.appSecret, creds.domain, signal)
      if (bot?.botName) setBotLabel(bot.botName)
      setQrStatus("success")
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return
      const message =
        err instanceof FeishuRegistrationError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      setQrError(message)
      setQrStatus("error")
    }
  }

  createEffect(() => {
    if (props.platform === "feishu" && form.mode === "qr" && qrStatus() === "idle") {
      void startQr()
    }
  })

  const canSave = createMemo(() => {
    if (!form.name.trim()) return false
    if (props.platform === "feishu") return !!form.appId.trim() && !!form.appSecret.trim()
    return !!form.botToken.trim()
  })

  const save = async () => {
    const name = form.name.trim()
    if (!name || !canSave()) return
    const existing = globalSync.data.config.channels ?? {}
    if (existing[name]) {
      showToast({
        title: language.t("config.channels.toast.error"),
        description: language.t("config.channels.error.duplicateName"),
      })
      return
    }
    setSaving(true)
    try {
      let config: ChannelConfig
      if (props.platform === "feishu") {
        const feishu: ChannelFeishuConfig = {
          type: "feishu",
          appId: form.appId.trim(),
          appSecret: form.appSecret.trim(),
          enabled: form.enabled,
          domain: form.domain,
        }
        const users = parseUserList(form.allowedUsers)
        if (users) feishu.allowedUsers = users
        if (form.model.trim()) feishu.model = form.model.trim()
        config = feishu
      } else {
        const discord: ChannelDiscordConfig = {
          type: "discord",
          botToken: form.botToken.trim(),
          enabled: form.enabled,
        }
        const users = parseUserList(form.allowedUsers)
        if (users) discord.allowedUsers = users
        if (form.proxy.trim()) discord.proxy = form.proxy.trim()
        if (form.model.trim()) discord.model = form.model.trim()
        config = discord
      }
      await globalSync.updateConfig({
        channels: { ...existing, [name]: config },
      } as Config)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("config.channels.toast.added"),
      })
      // reset name / secrets for next add, keep mode
      setForm("name", "")
      setForm("model", "")
      if (props.platform === "feishu") {
        setForm("appId", "")
        setForm("appSecret", "")
        setForm("allowedUsers", "")
        setBotLabel("")
        if (form.mode === "qr") {
          setQrStatus("idle")
        }
      } else {
        setForm("botToken", "")
        setForm("proxy", "")
        setForm("allowedUsers", "")
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("config.channels.toast.error"), description: message })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (name: string) => {
    try {
      const current = globalSync.data.config.channels ?? {}
      const next: Record<string, ChannelConfig> = {}
      for (const [k, v] of Object.entries(current)) {
        if (k !== name) next[k] = v
      }
      await globalSync.updateConfig({ channels: next } as Config)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("config.channels.toast.removed"),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("config.channels.toast.error"), description: message })
    }
  }

  const toggleEnabled = async (name: string, enabled: boolean) => {
    try {
      const current = globalSync.data.config.channels ?? {}
      const entry = current[name]
      if (!entry) return
      await globalSync.updateConfig({
        channels: { ...current, [name]: { ...entry, enabled } },
      } as Config)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("config.channels.toast.error"), description: message })
    }
  }

  const updateModel = async (name: string, model: string | undefined) => {
    try {
      const current = globalSync.data.config.channels ?? {}
      const entry = current[name]
      if (!entry) return
      const next = { ...entry } as ChannelConfig
      if (model) next.model = model
      else delete (next as { model?: string }).model
      await globalSync.updateConfig({
        channels: { ...current, [name]: next },
      } as Config)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("config.channels.toast.error"), description: message })
    }
  }

  const formModelCurrent = createMemo((): ModelOption => {
    const ref = parseModelRef(form.model)
    if (!ref) return modelAuto
    return (
      modelOptions().find(
        (item) =>
          item.value && item.value.providerID === ref.providerID && item.value.modelID === ref.modelID,
      ) ?? { value: ref, label: form.model }
    )
  })

  const rowModelCurrent = (model: string | undefined): ModelOption => {
    const ref = parseModelRef(model)
    if (!ref) return modelAuto
    return (
      modelOptions().find(
        (item) =>
          item.value && item.value.providerID === ref.providerID && item.value.modelID === ref.modelID,
      ) ?? { value: ref, label: model! }
    )
  }

  const title = () =>
    props.platform === "feishu"
      ? language.t("config.channels.platform.feishu")
      : language.t("config.channels.platform.discord")

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border-weak-base px-6 py-4">
        <div class="min-w-0">
          <div class="truncate text-20-medium text-text-strong">{title()}</div>
          <p class="mt-1 text-12-regular text-text-weak">
            {props.platform === "feishu"
              ? language.t("config.channels.platform.feishu.detail")
              : language.t("config.channels.platform.discord.detail")}
          </p>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div class="flex max-w-[720px] flex-col gap-8">
          {/* Existing channels */}
          <section class="flex flex-col gap-3">
            <div class="text-14-medium text-text-strong">{language.t("config.channels.existing.title")}</div>
            <Show
              when={rows().length > 0}
              fallback={
                <div class="rounded-xl border border-dashed border-border-weak-base bg-surface-base px-4 py-6 text-12-regular text-text-weak">
                  {language.t("config.channels.existing.empty")}
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={rows()}>
                  {(row) => (
                    <div class="flex flex-col gap-3 rounded-[14px] border border-border-weak-base bg-background-base/45 px-4 py-3">
                      <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-14-medium text-text-strong">{row.name}</div>
                          <div class="truncate font-mono text-11-regular text-text-weaker">{row.summary}</div>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                          <Toggle
                            checked={row.enabled}
                            onChange={(v) => void toggleEnabled(row.name, v)}
                            hideLabel
                          >
                            {row.name}
                          </Toggle>
                          <Button size="small" variant="ghost" icon="trash" onClick={() => void remove(row.name)}>
                            {language.t("config.channels.editor.delete")}
                          </Button>
                        </div>
                      </div>
                      <div class="flex flex-col gap-1">
                        <span class="text-12-medium text-text-base">{language.t("config.channels.field.model")}</span>
                        <Select
                          options={modelOptions()}
                          current={rowModelCurrent(row.model)}
                          value={(item) =>
                            item.value ? `${item.value.providerID}/${item.value.modelID}` : "auto"
                          }
                          label={(item) => item.label}
                          onSelect={(item) => {
                            void updateModel(row.name, formatModelRef(item?.value as ModelRef | undefined))
                          }}
                          variant="secondary"
                          size="small"
                          triggerVariant="settings"
                          triggerStyle={{ "min-width": "240px" }}
                        />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>

          {/* Add form */}
          <section class="flex flex-col gap-4 rounded-[14px] border border-border-weak-base bg-surface-base/40 p-4">
            <div class="text-14-medium text-text-strong">{language.t("config.channels.add.title")}</div>
            <p class="text-11-regular text-text-weaker">{language.t("config.channels.note.runtime")}</p>

            <TextField
              label={language.t("config.channels.field.name")}
              placeholder={props.platform === "feishu" ? "work-feishu" : "my-discord"}
              value={form.name}
              onChange={(v) => setForm("name", v ?? "")}
            />

            <Switch>
              <Match when={props.platform === "feishu"}>
                <div class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-base">{language.t("config.channels.feishu.setup")}</span>
                  <Select
                    options={[
                      { value: "qr" as const, label: language.t("config.channels.feishu.mode.qr") },
                      { value: "manual" as const, label: language.t("config.channels.feishu.mode.manual") },
                    ]}
                    current={
                      form.mode === "qr"
                        ? { value: "qr" as const, label: language.t("config.channels.feishu.mode.qr") }
                        : { value: "manual" as const, label: language.t("config.channels.feishu.mode.manual") }
                    }
                    value={(o) => o.value}
                    label={(o) => o.label}
                    onSelect={(o) => {
                      if (!o) return
                      stopQr()
                      setForm("mode", o.value)
                      setQrStatus("idle")
                      setQrError("")
                      setQrSession(null)
                      setQrImage("")
                    }}
                    variant="secondary"
                    size="large"
                  />
                </div>

                <Show when={form.mode === "qr"}>
                  <div class="flex flex-col gap-3 rounded-lg border border-border-weak-base p-3 bg-background-base">
                    <p class="text-12-regular text-text-weak">{language.t("config.channels.feishu.qr.hint")}</p>

                    <Show when={qrStatus() === "loading"}>
                      <p class="text-12-regular text-text-weak">{language.t("config.channels.feishu.qr.loading")}</p>
                    </Show>

                    <Show when={qrStatus() === "waiting" || qrStatus() === "success"}>
                      <div class="flex flex-col sm:flex-row gap-4 items-start">
                        <Show
                          when={qrImage()}
                          fallback={
                            <div class="flex flex-col gap-1 min-w-0">
                              <span class="text-11-regular text-text-weaker">
                                {language.t("config.channels.feishu.qr.openLink")}
                              </span>
                              <a
                                class="text-12-regular text-text-link break-all"
                                href={qrSession()?.qrUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {qrSession()?.qrUrl}
                              </a>
                            </div>
                          }
                        >
                          <img
                            src={qrImage()}
                            alt={language.t("config.channels.feishu.qr.alt")}
                            class="w-[200px] h-[200px] rounded bg-white p-1 shrink-0"
                          />
                        </Show>
                        <div class="flex flex-col gap-2 min-w-0">
                          <Show when={qrSession()?.userCode}>
                            <div class="flex flex-col gap-0.5">
                              <span class="text-11-regular text-text-weaker">
                                {language.t("config.channels.feishu.qr.userCode")}
                              </span>
                              <span class="text-18-medium text-text-strong font-mono tracking-wider">
                                {qrSession()!.userCode}
                              </span>
                            </div>
                          </Show>
                          <Show when={qrStatus() === "waiting"}>
                            <span class="text-12-regular text-text-weak">
                              {language.t("config.channels.feishu.qr.waiting")}
                            </span>
                          </Show>
                          <Show when={qrStatus() === "success"}>
                            <span class="text-12-regular text-green-600">
                              {language.t("config.channels.feishu.qr.success")}
                              <Show when={botLabel()}> ({botLabel()})</Show>
                            </span>
                          </Show>
                          <Button
                            size="small"
                            variant="ghost"
                            onClick={() => {
                              stopQr()
                              setQrStatus("idle")
                            }}
                          >
                            {language.t("config.channels.feishu.qr.refresh")}
                          </Button>
                        </div>
                      </div>
                    </Show>

                    <Show when={qrStatus() === "error"}>
                      <div class="flex flex-col gap-2">
                        <p class="text-12-regular text-red-500">{qrError()}</p>
                        <div class="flex gap-2">
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() => {
                              setQrStatus("idle")
                            }}
                          >
                            {language.t("config.channels.feishu.qr.retry")}
                          </Button>
                          <Button size="small" variant="ghost" onClick={() => setForm("mode", "manual")}>
                            {language.t("config.channels.feishu.mode.manual")}
                          </Button>
                        </div>
                      </div>
                    </Show>

                    <Show when={qrStatus() === "success"}>
                      <TextField
                        label={language.t("config.channels.field.appId")}
                        value={form.appId}
                        onChange={(v) => setForm("appId", v ?? "")}
                        readOnly
                      />
                      <TextField
                        label={language.t("config.channels.field.appSecret")}
                        type="password"
                        value={form.appSecret}
                        onChange={(v) => setForm("appSecret", v ?? "")}
                        readOnly
                      />
                    </Show>
                  </div>
                </Show>

                <Show when={form.mode === "manual"}>
                  <p class="text-12-regular text-text-weak">{language.t("config.channels.feishu.manual.hint")}</p>
                  <TextField
                    label={language.t("config.channels.field.appId")}
                    placeholder="cli_xxx"
                    value={form.appId}
                    onChange={(v) => setForm("appId", v ?? "")}
                  />
                  <TextField
                    label={language.t("config.channels.field.appSecret")}
                    type="password"
                    placeholder="••••••••"
                    value={form.appSecret}
                    onChange={(v) => setForm("appSecret", v ?? "")}
                  />
                </Show>
              </Match>

              <Match when={props.platform === "discord"}>
                <p class="text-12-regular text-text-weak">{language.t("config.channels.discord.hint")}</p>
                <TextField
                  label={language.t("config.channels.field.botToken")}
                  type="password"
                  placeholder="Bot token"
                  value={form.botToken}
                  onChange={(v) => setForm("botToken", v ?? "")}
                />
                <TextField
                  label={language.t("config.channels.field.proxy")}
                  placeholder="http://127.0.0.1:7890"
                  value={form.proxy}
                  onChange={(v) => setForm("proxy", v ?? "")}
                />
              </Match>
            </Switch>

            <div class="flex flex-col gap-1">
              <span class="text-12-medium text-text-base">{language.t("config.channels.field.model")}</span>
              <span class="text-11-regular text-text-weaker">{language.t("config.channels.field.model.hint")}</span>
              <Select
                options={modelOptions()}
                current={formModelCurrent()}
                value={(item) => (item.value ? `${item.value.providerID}/${item.value.modelID}` : "auto")}
                label={(item) => item.label}
                onSelect={(item) => {
                  const ref = item?.value as ModelRef | undefined
                  setForm("model", formatModelRef(ref) ?? "")
                }}
                variant="secondary"
                size="large"
                triggerVariant="settings"
              />
            </div>

            <TextField
              label={language.t("config.channels.field.allowedUsers")}
              description={language.t("config.channels.field.allowedUsers.hint")}
              placeholder={props.platform === "feishu" ? "ou_xxx" : "123456789"}
              value={form.allowedUsers}
              onChange={(v) => setForm("allowedUsers", v ?? "")}
              multiline
              rows={2}
            />

            <div class="flex items-center justify-between">
              <span class="text-12-medium text-text-base">{language.t("config.channels.field.enabled")}</span>
              <Toggle checked={form.enabled} onChange={(v) => setForm("enabled", v)} hideLabel>
                enabled
              </Toggle>
            </div>

            <div class="flex justify-end">
              <Button variant="primary" onClick={() => void save()} disabled={saving() || !canSave()}>
                {saving()
                  ? language.t("common.loading.ellipsis")
                  : language.t("config.channels.add.action")}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
