import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  on,
  onCleanup,
  type Component,
  createResource,
} from "solid-js"
import { createStore } from "solid-js/store"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import type { ChannelDiscordConfig, ChannelFeishuConfig, Config } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useGlobalSync } from "@/context/global-sync"
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
import { defaultChannelDirectory } from "@/pages/layout/helpers"
import {
  directoryAbsoluteToDisplay,
  directoryBrowseLeaf,
  directoryBrowsePath,
  displayToAbsolute,
  normalizeDirectoryPath,
  trimDirectoryTrailing,
  type BrowseEntry,
} from "@/components/dialog-select-directory"
import { usePlatform } from "@/context/platform"
import { ModelSelectorPopover, useBoundModelState } from "@/components/dialog-select-model"

export type ChannelPlatform = "feishu" | "discord"

type ChannelConfig = NonNullable<Config["channels"]>[string]

export const CHANNEL_PLATFORMS: ChannelPlatform[] = ["feishu"]

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

type ChannelRow = {
  name: string
  enabled: boolean
  model?: string
  config: ChannelConfig
}

type ChannelTestResult = {
  status: "success" | "error"
  botName?: string
  botOpenId?: string
  message?: string
}

const MODEL_AUTO = "auto"

/** Last channels write from this page — used to win races against global.config.updated. */
let pendingChannelWrite: Record<string, ChannelConfig> | undefined

function modelIdFromConfig(raw: string | undefined): string {
  return raw?.trim() ? raw.trim() : MODEL_AUTO
}

function modelConfigFromId(id: string | undefined): string | undefined {
  if (!id || id === MODEL_AUTO) return undefined
  return id
}

function isValidChannelDirectory(value: string): boolean {
  const path = value.trim()
  if (!path) return true
  if (/[^\x20-\x7e]/.test(path)) return false
  if (path.startsWith("~") && path.length > 1 && !path.startsWith("~/") && !path.startsWith("~\\")) return false
  return true
}

function channelDirectoryInputValue(name: string, configured: string | undefined, configDir: string): string {
  const value = configured?.trim()
  if (!value) return `${configDir.replace(/[\\/]$/, "")}/channels`
  const suffix = `/${name.trim()}`
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value
}

function channelNameSegment(name: string): string {
  return (
    name
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "channel"
  )
}

const ChannelDirectoryInput: Component<{
  value: string
  home: string
  name: string
  errorText: string
  onChange: (value: string) => void
}> = (props) => {
  const platform = usePlatform()
  let rootRef: HTMLDivElement | undefined
  const [state, setState] = createStore({ query: props.value, open: false, highlighted: 0 })

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || !rootRef?.contains(target)) setState("open", false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true))
  })

  const browsePath = createMemo(() => directoryBrowsePath(state.query))
  const absolutePath = createMemo(() => displayToAbsolute(browsePath(), props.home, props.home))
  const [entries] = createResource(
    absolutePath,
    async (directory) => {
      if (!directory || !platform.listLocalDirectory) return [] as BrowseEntry[]
      const list = await platform.listLocalDirectory(directory).catch(() => [])
      return list
        .filter((item) => item.kind === "directory")
        .map((item) => ({
          name: getFilename(item.path),
          path: trimDirectoryTrailing(normalizeDirectoryPath(item.path)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    { initialValue: [] as BrowseEntry[] },
  )
  const filtered = createMemo(() => {
    const leaf = directoryBrowseLeaf(state.query).toLocaleLowerCase()
    return (entries.latest ?? []).filter((entry) => entry.name.toLocaleLowerCase().startsWith(leaf)).slice(0, 8)
  })

  const commit = (value: string) => {
    const normalized = normalizeDirectoryPath(value).replace(/[\\/]$/, "")
    setState({ query: normalized, open: false })
    props.onChange(normalized)
  }

  return (
    <div ref={(node) => (rootRef = node)} class="relative">
      <div class="flex h-10 overflow-hidden rounded-lg border border-border-weak-base bg-background-base transition-colors focus-within:border-border-strong-base focus-within:ring-1 focus-within:ring-border-strong-base">
        <input
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={state.open && !!platform.listLocalDirectory}
          value={state.query}
          onFocus={() => setState("open", true)}
          onInput={(event) => {
            const value = normalizeDirectoryPath(event.currentTarget.value)
            setState({ query: value, open: true, highlighted: 0 })
            props.onChange(value)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              const count = filtered().length
              if (!count) return
              const delta = event.key === "ArrowDown" ? 1 : -1
              setState("highlighted", Math.max(0, Math.min(count - 1, state.highlighted + delta)))
            }
            if (event.key === "Enter" && filtered()[state.highlighted] && !state.query.endsWith("/")) {
              event.preventDefault()
              commit(directoryAbsoluteToDisplay(filtered()[state.highlighted].path, props.home))
            }
            if (event.key === "Escape") setState("open", false)
          }}
          spellcheck={false}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          aria-invalid={!isValidChannelDirectory(state.query)}
          class="min-w-0 flex-1 bg-transparent px-3 font-mono text-13-regular text-text-strong outline-none placeholder:text-text-weaker"
        />
        <span class="flex shrink-0 items-center border-l border-border-weak-base bg-surface-base/60 px-3 font-mono text-13-regular text-text-weak">
          /{channelNameSegment(props.name)}
        </span>
      </div>
      <Show when={!isValidChannelDirectory(state.query)}>
        <div class="mt-1 text-12-regular text-text-danger">{props.errorText}</div>
      </Show>
      <Show when={state.open && !!platform.listLocalDirectory && filtered().length > 0}>
        <div class="absolute inset-x-0 top-[calc(100%+0.375rem)] z-20 rounded-xl border border-border-weak-base bg-surface-raised-base p-1.5 shadow-lg">
          <For each={filtered()}>
            {(entry, index) => (
              <button
                type="button"
                class="flex w-full items-center rounded-lg px-3 py-2 text-left text-13-regular outline-none transition-colors hover:bg-surface-base-hover active:bg-surface-base-active"
                classList={{ "bg-surface-base-active": state.highlighted === index() }}
                onMouseEnter={() => setState("highlighted", index())}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(directoryAbsoluteToDisplay(entry.path, props.home))}
              >
                <span class="min-w-0 truncate font-mono">{entry.name}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

const ChannelModelSelector: Component<{
  value: string
  onChange: (value: string) => void
}> = (props) => {
  const language = useLanguage()
  const model = useBoundModelState({
    value: () => (props.value === MODEL_AUTO ? "" : props.value),
    onChange: props.onChange,
  })
  const current = () => model.current()

  return (
    <ModelSelectorPopover
      model={model}
      placement="bottom-start"
      flip={false}
      fitViewport
      triggerAs={Button}
      triggerProps={{
        type: "button",
        variant: "ghost",
        class:
          "h-10 w-full min-w-0 justify-between rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong transition-colors hover:bg-surface-base-hover focus-visible:ring-2 focus-visible:ring-border-focus-base",
      }}
    >
      <div class="flex min-w-0 items-center gap-2">
        <Show when={current()?.provider.id}>
          <ProviderIcon id={current()!.provider.id} class="size-4 shrink-0" />
        </Show>
        <span class="truncate">
          {current()
            ? `${current()!.provider.name} / ${current()!.name}`
            : language.t("config.channels.field.model.auto")}
        </span>
      </div>
      <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak" />
    </ModelSelectorPopover>
  )
}

export function useChannelRows(platform: () => ChannelPlatform | undefined) {
  const globalSync = useGlobalSync()
  return createMemo((): ChannelRow[] => {
    const p = platform()
    if (!p) return []
    // Touch top-level config so Solid tracks replacement of the whole config object.
    const config = globalSync.data.config
    const cfg = config.channels ?? {}
    const configDir = globalSync.data.path.config || "~/.config/opencode"
    return Object.entries(cfg)
      .filter(([, entry]) => entry?.type === p)
      .map(([name, entry]) => {
        const dir = entry.directory?.trim() || defaultChannelDirectory(name, configDir)
        return {
          name,
          enabled: entry.enabled !== false,
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
      if (entry?.type === "feishu") feishu++
      if (entry?.type === "discord") discord++
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
  const rows = useChannelRows(() => props.platform)
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
    /** Working folder for this channel (decoupled from OpenCode projects). */
    directory: "",
    mode: "manual" as "qr" | "manual",
  })
  const [saving, setSaving] = createSignal(false)
  const [testingChannel, setTestingChannel] = createSignal<string | null>(null)
  const [channelTests, setChannelTests] = createStore<Record<string, ChannelTestResult>>({})
  const [qrStatus, setQrStatus] = createSignal<"idle" | "loading" | "waiting" | "success" | "error">("idle")
  const [qrSession, setQrSession] = createSignal<FeishuRegistrationSession | null>(null)
  const [qrError, setQrError] = createSignal("")
  const [qrImage, setQrImage] = createSignal("")
  const [botLabel, setBotLabel] = createSignal("")
  const [expanded, setExpanded] = createSignal<string | null>(null)
  /** UI source of truth for model dropdowns (survives config SSE races). */
  const [draftModels, setDraftModels] = createStore<Record<string, string>>({})

  let abort: AbortController | null = null
  const stopQr = () => {
    abort?.abort()
    abort = null
  }
  onCleanup(() => stopQr())

  // Only reset form when platform actually changes (not on every config refresh).
  createEffect(
    on(
      () => props.platform,
      (p) => {
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
          directory: "",
          // Default to manual so existing credentials are easier to re-enter;
          // user can still switch to QR.
          mode: "manual",
        })
        setQrStatus("idle")
        setQrError("")
        setQrSession(null)
        setQrImage("")
        setBotLabel("")
        setExpanded(null)
        void p
      },
    ),
  )

  // Seed draft models from config once per channel name (do not overwrite user picks).
  createEffect(() => {
    for (const row of rows()) {
      if (draftModels[row.name] === undefined) {
        setDraftModels(row.name, modelIdFromConfig(row.model))
      }
    }
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
        err instanceof FeishuRegistrationError ? err.message : err instanceof Error ? err.message : String(err)
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
    if (!isValidChannelDirectory(form.directory)) return false
    if (props.platform === "feishu") return !!form.appId.trim() && !!form.appSecret.trim()
    return !!form.botToken.trim()
  })

  const formModelId = createMemo(() => modelIdFromConfig(form.model))

  /** Force store.channels to our written map (authority for this page). */
  const applyLocalChannels = (channels: Record<string, ChannelConfig>) => {
    globalSync.set("config", { ...globalSync.data.config, channels } as Config)
    return channels
  }

  const persistChannels = async (channels: Record<string, ChannelConfig>) => {
    // Mark pending write so late global.config.updated events can be re-applied.
    pendingChannelWrite = channels
    try {
      // updateConfig already merges writtenChannels into the response; re-apply
      // again so any later SSE event cannot leave the UI on a stale model.
      await globalSync.updateConfig({ channels } as Config)
      applyLocalChannels(channels)
      queueMicrotask(() => {
        if (pendingChannelWrite === channels) applyLocalChannels(channels)
      })
      window.setTimeout(() => {
        if (pendingChannelWrite === channels) {
          applyLocalChannels(channels)
          pendingChannelWrite = undefined
        }
      }, 150)
      return globalSync.data.config
    } catch (err) {
      pendingChannelWrite = undefined
      throw err
    }
  }

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
      // Default: {path.config}/channels/{name} — same family as quick-assistant.
      const configDir = globalSync.data.path.config || "~/.config/opencode"
      const directory = form.directory.trim() || defaultChannelDirectory(name, configDir)
      if (props.platform === "feishu") {
        const feishu: ChannelFeishuConfig = {
          type: "feishu",
          appId: form.appId.trim(),
          appSecret: form.appSecret.trim(),
          enabled: form.enabled,
          domain: form.domain,
          directory,
        }
        const users = parseUserList(form.allowedUsers)
        if (users) feishu.allowedUsers = users
        const model = modelConfigFromId(formModelId())
        if (model) feishu.model = model
        config = feishu
      } else {
        const discord: ChannelDiscordConfig = {
          type: "discord",
          botToken: form.botToken.trim(),
          enabled: form.enabled,
          directory,
        }
        const users = parseUserList(form.allowedUsers)
        if (users) discord.allowedUsers = users
        if (form.proxy.trim()) discord.proxy = form.proxy.trim()
        const model = modelConfigFromId(formModelId())
        if (model) discord.model = model
        config = discord
      }

      const channels = { ...existing, [name]: config }
      await persistChannels(channels)

      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("config.channels.toast.added"),
        description: name,
      })
      // Clear only the add form; list reads from config.
      setForm("name", "")
      setForm("model", "")
      setForm("allowedUsers", "")
      setForm("directory", "")
      if (props.platform === "feishu") {
        setForm("appId", "")
        setForm("appSecret", "")
        setBotLabel("")
        if (form.mode === "qr") setQrStatus("idle")
      } else {
        setForm("botToken", "")
        setForm("proxy", "")
      }
      setExpanded(name)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("config.channels.toast.error"), description: message })
    } finally {
      setSaving(false)
    }
  }

  const patchChannel = async (name: string, patch: Partial<ChannelConfig>) => {
    const current = globalSync.data.config.channels ?? {}
    const entry = current[name]
    if (!entry) return
    const nextEntry = { ...entry, ...patch } as ChannelConfig
    // Drop empty model
    if ("model" in patch && !patch.model) {
      delete (nextEntry as { model?: string }).model
    }
    try {
      await persistChannels({ ...current, [name]: nextEntry })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("config.channels.toast.error"), description: message })
      throw err
    }
  }

  const setChannelModel = async (name: string, modelId: string) => {
    // Update draft immediately so the native <select> cannot snap back.
    setDraftModels(name, modelId)
    const model = modelConfigFromId(modelId)
    try {
      await patchChannel(name, { model } as Partial<ChannelConfig>)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("config.channels.toast.modelSaved"),
        description: model ?? language.t("config.channels.field.model.auto"),
      })
    } catch {
      // Keep draft as user selected; error toast already shown by patchChannel.
    }
  }

  const testChannel = async (name: string) => {
    const entry = globalSync.data.config.channels?.[name]
    if (!entry || entry.type !== "feishu" || testingChannel()) return
    setTestingChannel(name)
    try {
      const bot = await probeBot(entry.appId, entry.appSecret, entry.domain ?? "feishu")
      if (!bot) throw new Error(language.t("config.channels.test.failed"))
      setChannelTests(name, {
        status: "success",
        botName: bot.botName,
        botOpenId: bot.botOpenId,
      })
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("config.channels.test.success"),
        description: bot.botName ?? language.t("config.channels.test.success"),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setChannelTests(name, { status: "error", message })
      showToast({
        title: language.t("config.channels.test.failed"),
        description: message,
      })
    } finally {
      setTestingChannel(null)
    }
  }

  const remove = async (name: string) => {
    try {
      const current = globalSync.data.config.channels ?? {}
      const next: Record<string, ChannelConfig> = {}
      for (const [k, v] of Object.entries(current)) {
        if (k !== name) next[k] = v
      }
      await persistChannels(next)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("config.channels.toast.removed"),
      })
      if (expanded() === name) setExpanded(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("config.channels.toast.error"), description: message })
    }
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
        <div class="flex w-full flex-col gap-8">
          {/* Existing channels */}
          <section class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-2">
              <div class="text-14-medium text-text-strong">{language.t("config.channels.existing.title")}</div>
              <div class="text-11-regular text-text-weaker">
                {language.t("config.channels.existing.count", { count: rows().length })}
              </div>
            </div>
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
                  {(row) => {
                    const open = () => expanded() === row.name
                    const feishu = () => (row.config.type === "feishu" ? row.config : undefined)
                    const discord = () => (row.config.type === "discord" ? row.config : undefined)
                    return (
                      <div
                        class="flex flex-col gap-3 rounded-[14px] border border-border-base bg-surface-base/55 px-4 py-3 transition-colors duration-150 hover:bg-surface-base-hover"
                        classList={{ "opacity-60": !row.enabled }}
                      >
                        <div class="flex items-center justify-between gap-3">
                          <button
                            type="button"
                            class="min-w-0 flex-1 text-left"
                            onClick={() => setExpanded(open() ? null : row.name)}
                          >
                            <div class="truncate text-14-medium text-text-strong">{row.name}</div>
                          </button>
                          <div class="flex shrink-0 items-center gap-2">
                            <Show when={feishu()}>
                              <Button
                                size="small"
                                variant="ghost"
                                icon="link"
                                disabled={testingChannel() !== null}
                                onClick={() => void testChannel(row.name)}
                              >
                                {testingChannel() === row.name
                                  ? language.t("config.channels.test.testing")
                                  : language.t("config.channels.test.action")}
                              </Button>
                            </Show>
                            <Show when={channelTests[row.name]}>
                              {(result) => (
                                <div
                                  class={`max-w-[280px] truncate text-11-regular ${
                                    result().status === "success" ? "text-text-success" : "text-text-danger"
                                  }`}
                                  title={
                                    result().status === "success"
                                      ? `${result().botName ?? ""} ${result().botOpenId ?? ""}`.trim()
                                      : result().message
                                  }
                                >
                                  {result().status === "success"
                                    ? `${language.t("config.channels.test.botName")}: ${result().botName ?? "-"} · ${language.t("config.channels.test.botOpenId")}: ${result().botOpenId ?? "-"}`
                                    : result().message}
                                </div>
                              )}
                            </Show>
                            <Toggle
                              checked={row.enabled}
                              onChange={(v) => void patchChannel(row.name, { enabled: v })}
                              hideLabel
                            >
                              {row.name}
                            </Toggle>
                            <Button size="small" variant="ghost" icon="trash" onClick={() => void remove(row.name)}>
                              {language.t("config.channels.editor.delete")}
                            </Button>
                          </div>
                        </div>

                        <Show when={open()}>
                          <div class="flex flex-col gap-3 border-t border-border-weak-base pt-3">
                            <Show when={feishu()}>
                              {(cfg) => (
                                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  <TextField
                                    label={language.t("config.channels.field.appId")}
                                    class="font-mono"
                                    value={cfg().appId}
                                    onChange={(v) =>
                                      void patchChannel(row.name, { appId: v ?? "" } as Partial<ChannelFeishuConfig>)
                                    }
                                  />
                                  <TextField
                                    label={language.t("config.channels.field.appSecret")}
                                    class="font-mono"
                                    type="password"
                                    value={cfg().appSecret}
                                    onChange={(v) =>
                                      void patchChannel(row.name, {
                                        appSecret: v ?? "",
                                      } as Partial<ChannelFeishuConfig>)
                                    }
                                  />
                                </div>
                              )}
                            </Show>
                            <Show when={discord()}>
                              {(cfg) => (
                                <>
                                  <TextField
                                    label={language.t("config.channels.field.botToken")}
                                    type="password"
                                    value={cfg().botToken}
                                    onChange={(v) =>
                                      void patchChannel(row.name, {
                                        botToken: v ?? "",
                                      } as Partial<ChannelDiscordConfig>)
                                    }
                                  />
                                  <TextField
                                    label={language.t("config.channels.field.proxy")}
                                    value={cfg().proxy ?? ""}
                                    onChange={(v) =>
                                      void patchChannel(row.name, {
                                        proxy: v?.trim() || undefined,
                                      } as Partial<ChannelDiscordConfig>)
                                    }
                                  />
                                </>
                              )}
                            </Show>

                            <div class="flex flex-col gap-1">
                              <span class="text-12-medium text-text-base">
                                {language.t("config.channels.field.directory")}
                              </span>
                              <p class="text-11-regular text-text-weaker">
                                {language.t("config.channels.field.directory.hint")}
                              </p>
                              <ChannelDirectoryInput
                                value={channelDirectoryInputValue(
                                  row.name,
                                  row.config.directory,
                                  globalSync.data.path.config || "~/.config/opencode",
                                )}
                                home={globalSync.data.path.home}
                                name={row.name}
                                errorText={language.t("config.channels.field.directory.invalid")}
                                onChange={(value) => {
                                  if (!isValidChannelDirectory(value)) return
                                  void patchChannel(row.name, { directory: value })
                                }}
                              />
                            </div>

                            <div class="flex flex-col gap-1">
                              <span class="text-12-medium text-text-base">
                                {language.t("config.channels.field.model")}
                              </span>
                              <ChannelModelSelector
                                value={draftModels[row.name] ?? modelIdFromConfig(row.model)}
                                onChange={(value) => void setChannelModel(row.name, value)}
                              />
                            </div>
                          </div>
                        </Show>
                      </div>
                    )
                  }}
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

            <div class="flex flex-col gap-1">
              <span class="text-12-medium text-text-base">{language.t("config.channels.field.directory")}</span>
              <p class="text-11-regular text-text-weaker">{language.t("config.channels.field.directory.hint")}</p>
              <ChannelDirectoryInput
                value={form.directory}
                home={globalSync.data.path.home}
                name={form.name.trim() || "channel-name"}
                errorText={language.t("config.channels.field.directory.invalid")}
                onChange={(value) => setForm("directory", value)}
              />
            </div>

            <Switch>
              <Match when={props.platform === "feishu"}>
                <div class="flex flex-col gap-1">
                  <span class="text-12-medium text-text-base">{language.t("config.channels.feishu.setup")}</span>
                  <select
                    class="h-10 w-full cursor-pointer rounded-lg border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong outline-none transition-[background-color,box-shadow] hover:bg-surface-base-hover focus:bg-surface-base-hover focus-visible:ring-2 focus-visible:ring-border-focus-base active:bg-surface-base-active disabled:cursor-not-allowed disabled:opacity-50"
                    value={form.mode}
                    onChange={(event) => {
                      const mode = event.currentTarget.value as "qr" | "manual"
                      stopQr()
                      setForm("mode", mode)
                      setQrStatus("idle")
                      setQrError("")
                      setQrSession(null)
                      setQrImage("")
                    }}
                  >
                    <option value="qr">{language.t("config.channels.feishu.mode.qr")}</option>
                    <option value="manual">{language.t("config.channels.feishu.mode.manual")}</option>
                  </select>
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
                          <Button size="small" variant="secondary" onClick={() => setQrStatus("idle")}>
                            {language.t("config.channels.feishu.qr.retry")}
                          </Button>
                          <Button size="small" variant="ghost" onClick={() => setForm("mode", "manual")}>
                            {language.t("config.channels.feishu.mode.manual")}
                          </Button>
                        </div>
                      </div>
                    </Show>

                    <Show when={qrStatus() === "success"}>
                      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <TextField
                          label={language.t("config.channels.field.appId")}
                          class="font-mono"
                          value={form.appId}
                          onChange={(v) => setForm("appId", v ?? "")}
                        />
                        <TextField
                          label={language.t("config.channels.field.appSecret")}
                          class="font-mono"
                          type="password"
                          value={form.appSecret}
                          onChange={(v) => setForm("appSecret", v ?? "")}
                        />
                      </div>
                    </Show>
                  </div>
                </Show>

                <Show when={form.mode === "manual"}>
                  <p class="text-12-regular text-text-weak">{language.t("config.channels.feishu.manual.hint")}</p>
                  <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <TextField
                      label={language.t("config.channels.field.appId")}
                      class="font-mono"
                      placeholder="cli_xxx"
                      value={form.appId}
                      onChange={(v) => setForm("appId", v ?? "")}
                    />
                    <TextField
                      label={language.t("config.channels.field.appSecret")}
                      class="font-mono"
                      type="password"
                      placeholder="••••••••"
                      value={form.appSecret}
                      onChange={(v) => setForm("appSecret", v ?? "")}
                    />
                  </div>
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
              <ChannelModelSelector value={formModelId()} onChange={(value) => setForm("model", value)} />
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
                {saving() ? language.t("common.loading.ellipsis") : language.t("config.channels.add.action")}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
