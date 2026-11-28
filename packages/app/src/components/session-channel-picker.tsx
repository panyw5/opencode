import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Select } from "@opencode-ai/ui/select"
import { Tag } from "@opencode-ai/ui/tag"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate } from "@solidjs/router"
import type { AgentSession, Session } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSessionTabs } from "@/context/session-tabs"
import { useSync } from "@/context/sync"
import { useSessionLayout } from "@/pages/session/session-layout"
import { useSDK } from "@/context/sdk"
import "./session-channel-picker.css"

export const CHANNEL_IDS = [
  "codex",
  "claude",
  "grok",
  "dsh",
  "pi",
  "cline",
  "droid",
  "qoder",
  "antigravity",
  "devin",
] as const
type ChannelID = (typeof CHANNEL_IDS)[number]
export const CHANNEL_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok",
  dsh: "DSH",
  pi: "Pi",
  cline: "Cline",
  droid: "Factory Droid",
  qoder: "Qoder",
  antigravity: "Antigravity",
  devin: "Devin",
}

const CHANNEL_ICONS: Record<string, string> = {
  codex: "openai",
  claude: "anthropic",
  grok: "xai",
  dsh: "deepseek",
}

/** Vendor brand colors; monochrome marks without one keep the surrounding text color. */
const CHANNEL_COLORS: Record<string, string> = {
  claude: "#D97757",
  dsh: "#4D6BFE",
  pi: "#E0A62E",
  cline: "#A78BFA",
  droid: "#EF6F2E",
  qoder: "#2ADB5C",
  antigravity: "#3186FF",
}

export function ChannelIcon(props: { id: string; class?: string }) {
  const cls = () => props.class ?? "size-[22px] shrink-0"
  // Official marks from the vendors' own sites.
  if (props.id === "opencode")
    return (
      <svg viewBox="0 0 240 300" class={cls()} aria-hidden="true">
        <path fill="currentColor" fill-opacity="0.38" d="M180 240H60V120H180V240Z" />
        <path fill="currentColor" d="M180 60H60V240H180V60ZM240 300H0V0H240V300Z" />
      </svg>
    )
  if (props.id === "pi")
    return (
      <svg viewBox="0 0 800 800" class={cls()} aria-hidden="true">
        <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
        <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
        <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
      </svg>
    )
  return (
    <ProviderIcon
      id={CHANNEL_ICONS[props.id] ?? props.id}
      class={cls()}
      style={{ color: CHANNEL_COLORS[props.id] }}
      aria-hidden="true"
    />
  )
}

type BackendConfig = { type?: string; command?: readonly string[] }
type AgentToggle = { enabled?: boolean } | undefined

/** Advisors that can actually drive a session: enabled and ACP configured with a command. */
export function readyChannels(config?: {
  agent_backends?: Record<string, BackendConfig | undefined>
  external_agents?: Record<string, AgentToggle>
  pi?: AgentToggle
}) {
  return CHANNEL_IDS.filter((id) => {
    const backend = config?.agent_backends?.[id]
    if (backend?.type !== "acp" || !backend.command?.[0]?.trim()) return false
    const toggle = id === "pi" ? config?.pi : config?.external_agents?.[id]
    return toggle?.enabled !== false
  }).map((id) => ({ id, label: CHANNEL_LABELS[id] }))
}

export function ChannelToggles(props: {
  options: Array<{ id: string; label: string }>
  current?: string
  onSelect: (advisor: string | undefined) => void
}) {
  const language = useLanguage()
  const choices = createMemo(() => [{ id: "opencode", label: language.t("prompt.channel.native") }, ...props.options])
  return (
    <Show when={choices().length > 0}>
      <div data-slot="prompt-channels" class="flex flex-wrap items-center justify-center gap-2">
        {choices().map((item) => {
          const active = item.id === (props.current ?? "opencode")
          return (
            <Button
              type="button"
              size="large"
              variant="ghost"
              class="rounded-full border transition-colors"
              style={{
                height: "40px",
                "padding-inline": "16px",
                "font-size": "15px",
                gap: "8px",
                "border-radius": "9999px",
              }}
              classList={{
                "border-border-weak-base bg-surface-base-active text-text-strong": active,
                "border-transparent text-text-weak hover:bg-surface-base-hover hover:text-text-strong": !active,
              }}
              aria-pressed={active}
              title={language.t("prompt.channel.label")}
              onClick={() => props.onSelect(item.id === "opencode" || active ? undefined : item.id)}
            >
              <ChannelIcon id={item.id} />
              <span>{item.label}</span>
            </Button>
          )
        })}
      </div>
    </Show>
  )
}

/** Read-only channel type hint for a session whose channel can no longer change. */
export function ChannelBadge(props: { id: string }) {
  const language = useLanguage()
  return (
    <div
      data-slot="prompt-channel-badge"
      class="flex h-9 shrink-0 select-none items-center gap-2 rounded-full border border-border-weak-base px-3.5 text-13-medium text-text-weak"
      title={language.t("prompt.channel.locked")}
    >
      <ChannelIcon id={props.id} class="size-5 shrink-0" />
      <span class="whitespace-nowrap">{CHANNEL_LABELS[props.id] ?? props.id}</span>
    </div>
  )
}

export function ChannelModelSelect(props: {
  sessionID?: string
  advisor?: string
  draftModel?: string
  onSelectModel?: (model: string) => void
  draftMode?: string
  onSelectMode?: (mode: string) => void
  triggerStyle?: JSX.CSSProperties
  class?: string
  modeClass?: string
  compact?: boolean
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore<{
    loading: boolean
    loaded: boolean
    current?: string
    options: Array<{ id: string; name: string }>
    currentMode?: string
    modes: Array<{ id: string; name: string }>
  }>({ loading: false, loaded: false, options: [], modes: [] })
  const [revision, setRevision] = createSignal(0)

  const load = async () => {
    if (state.loaded || state.loading) return
    if (!props.sessionID && !props.advisor) return
    setState("loading", true)
    const target = props.sessionID ? `session=${props.sessionID}` : `advisor=${props.advisor}`
    console.debug(`[channel] loading options ${target}`)
    try {
      const result = props.sessionID
        ? await sdk.client.session.channel({ sessionID: props.sessionID })
        : await sdk.client.agentBackend.channelOptions({ advisor: props.advisor as ChannelID })
      const data = result.data
      if (data) {
        setState({
          options: data.models ?? [],
          current: props.sessionID ? data.model : (props.draftModel ?? data.model),
          modes: data.modes ?? [],
          currentMode: props.sessionID ? data.mode : (props.draftMode ?? data.mode),
          loaded: true,
        })
        console.debug(
          `[channel] loaded options ${target} models=${data.models?.length ?? 0} modes=${data.modes?.length ?? 0} mode=${data.mode ?? "none"}`,
        )
      }
    } catch (error) {
      console.warn(`[channel] options failed ${target} error=${String(error)}`)
      setState("loaded", true)
    } finally {
      setState("loading", false)
      setRevision((value) => value + 1)
    }
  }

  const select = async (model: string | undefined) => {
    if (!model) return
    if (!props.sessionID) {
      props.onSelectModel?.(model)
      return
    }
    const previous = state.current
    setState("current", model)
    try {
      await sdk.client.session.channelUpdate({
        sessionID: props.sessionID,
        channelUpdateInput: { model },
      })
      console.debug(`[channel] model updated session=${props.sessionID} model=${model}`)
    } catch (error) {
      console.warn(`[channel] model update failed session=${props.sessionID} model=${model} error=${String(error)}`)
      setState("current", previous)
    }
  }

  const selectMode = async (mode: string | undefined) => {
    if (!mode) return
    if (!props.sessionID) {
      props.onSelectMode?.(mode)
      return
    }
    const previous = state.currentMode
    setState("currentMode", mode)
    try {
      await sdk.client.session.channelUpdate({
        sessionID: props.sessionID,
        channelUpdateInput: { mode },
      })
      console.debug(`[channel] mode updated session=${props.sessionID} mode=${mode}`)
    } catch (error) {
      console.warn(`[channel] mode update failed session=${props.sessionID} mode=${mode} error=${String(error)}`)
      setState("currentMode", previous)
    }
  }

  const models = createMemo(() => {
    revision()
    return state.options
  })
  const modes = createMemo(() => {
    revision()
    return state.modes
  })
  // Load before the menu opens so the list is ready when the popover shows.
  createEffect(() => {
    if (props.sessionID || props.advisor) void load()
  })
  const selected = () => (props.sessionID ? state.current : (props.draftModel ?? state.current))
  const current = createMemo(() => {
    revision()
    const value = selected()
    if (!value) return undefined
    const list = models()
    return (
      list.find((item) => item.id === value) ??
      // Codex reports the reasoning effort alongside the model, e.g. "gpt-6.1-sol[high]".
      list.find((item) => value.startsWith(`${item.id}[`))
    )
  })
  const selectedMode = () => (props.sessionID ? state.currentMode : (props.draftMode ?? state.currentMode))
  const currentMode = createMemo(() => {
    revision()
    const list = modes()
    if (list.length === 0) return undefined
    const value = selectedMode()
    return (value ? list.find((item) => item.id === value) : undefined) ?? list[0]
  })
  const [open, setOpen] = createSignal(false)
  // Retry a failed or empty load when the menu is opened again.
  const retry = () => {
    if (state.loading || (state.loaded && state.options.length)) return
    setState("loaded", false)
    void load()
  }
  const label = () => CHANNEL_LABELS[props.advisor!] ?? props.advisor

  return (
    <>
      <Show when={props.advisor && modes().length > 0}>
        <Select
          size={props.compact ? "small" : "normal"}
          options={modes()}
          current={currentMode()}
          value={(item) => item.id}
          label={(item) => item.name}
          onSelect={(item) => void selectMode(item?.id)}
          class={props.modeClass ?? props.class ?? "prompt-pick prompt-agent"}
          valueClass="truncate"
          triggerStyle={props.triggerStyle}
          variant="ghost"
          triggerProps={{
            "aria-label": language.t("prompt.channel.mode"),
            "data-slot": "prompt-channel-mode",
          }}
        />
      </Show>
      <Show
        when={props.advisor}
      fallback={
        <Button
          type="button"
          variant="ghost"
          size={props.compact ? "small" : "normal"}
          class={props.class ?? "prompt-pick"}
          style={props.triggerStyle}
          disabled
        >
          <span class="truncate">{language.t("prompt.channel.model")}</span>
        </Button>
      }
    >
      <Kobalte
        open={open()}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) retry()
        }}
        modal={false}
        placement="top-start"
        flip
        gutter={4}
      >
        <Kobalte.Trigger
          as={Button}
          type="button"
          variant="ghost"
          size={props.compact ? "small" : "normal"}
          class={props.class ?? "prompt-pick"}
          style={props.triggerStyle}
          aria-label={language.t("prompt.channel.model")}
        >
          <span class="truncate">{current()?.name ?? language.t("prompt.channel.model")}</span>
          <Icon name="chevron-down" size="small" class="shrink-0" />
        </Kobalte.Trigger>
        <Kobalte.Portal>
          <Kobalte.Content
            data-component="popover-content"
            data-kb-top-layer=""
            class="w-[390px] max-w-[calc(100vw-24px)] h-[39rem] max-h-[calc(100vh-96px)] flex flex-col p-2 overflow-hidden"
            style={{ "z-index": 100 }}
          >
            <Kobalte.Title class="sr-only">{language.t("prompt.channel.model")}</Kobalte.Title>
            <div
              class="mb-2 rounded-lg border px-3 py-2.5"
              style={{ "background-color": "var(--apple-light-alpha-5)", "border-color": "var(--border-weak-base)" }}
            >
              <div class="flex min-w-0 items-start gap-2.5">
                <ChannelIcon id={props.advisor!} class="mt-0.5 size-6 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-16-medium font-semibold text-text-strong">
                    {current()?.name ?? language.t("prompt.channel.model")}
                  </div>
                  <div class="mt-0.5 truncate text-12-regular text-text-weak">{label()}</div>
                </div>
              </div>
            </div>
            <List
              class="model-selector-list flex-1 min-h-0 [&_[data-slot=list-viewport]]:flex-1 [&_[data-slot=list-viewport]]:min-h-0 p-1"
              virtual={false}
              search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true }}
              emptyMessage={state.loading ? language.t("prompt.channel.loading") : language.t("prompt.channel.empty")}
              key={(item) => item.id}
              items={models()}
              current={current()}
              filterKeys={["name", "id"]}
              sortBy={(a, b) => a.name.localeCompare(b.name)}
              groupBy={label}
              groupHeader={() => (
                <span data-slot="model-provider-heading">
                  <ChannelIcon id={props.advisor!} class="size-4 shrink-0" />
                  <span class="truncate">{label()}</span>
                </span>
              )}
              onSelect={(item) => {
                setOpen(false)
                void select(item?.id)
              }}
            >
              {(item) => (
                <div class="w-full flex items-center gap-x-2 text-13-regular">
                  <span class="truncate">{item.name}</span>
                </div>
              )}
            </List>
          </Kobalte.Content>
        </Kobalte.Portal>
      </Kobalte>
    </Show>
    </>
  )
}

type AgentSessionItem = { id: string; name: string; updated?: string }

/** Button that opens a floating dialog listing the agent's existing sessions. */
export function ChannelSessionPicker(props: {
  advisor: string
  model?: string
  mode?: string
  class?: string
  triggerStyle?: JSX.CSSProperties
  compact?: boolean
}) {
  const dialog = useDialog()
  const language = useLanguage()
  return (
    <Button
      type="button"
      variant="ghost"
      size={props.compact ? "small" : "normal"}
      class={props.class ?? "prompt-pick"}
      style={props.triggerStyle}
      aria-label={language.t("prompt.channel.sessions")}
      onClick={() =>
        dialog.show(() => <AgentSessionDialog advisor={props.advisor} model={props.model} mode={props.mode} />)
      }
    >
      <Icon name="clock" size="small" class="shrink-0" />
      <span class="truncate">{language.t("prompt.channel.sessions")}</span>
    </Button>
  )
}

type PreviewMessage = { kind: string; text: string }

function AgentSessionDialog(props: { advisor: string; model?: string; mode?: string }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const language = useLanguage()
  const navigate = useNavigate()
  const layout = useLayout()
  const sessionTabs = useSessionTabs()
  const sync = useSync()
  const { params } = useSessionLayout()
  const [state, setState] = createStore<{
    loading: boolean
    supported: boolean
    busy?: string
    sessions: AgentSession[]
  }>({ loading: true, supported: true, sessions: [] })
  const [selected, setSelected] = createSignal<AgentSessionItem>()
  const [preview, setPreview] = createStore<{
    loading: boolean
    failed: boolean
    unavailable?: string
    messages: PreviewMessage[]
  }>({
    loading: false,
    failed: false,
    messages: [],
  })
  const previewCache = new Map<string, { messages: PreviewMessage[]; unavailable?: string }>()

  onMount(async () => {
    try {
      const result = await sdk.client.agentBackend.agentSessions({ advisor: props.advisor as ChannelID })
      const data = result.data
      setState({
        supported: !!data?.supported && !!data?.loadable,
        sessions: data?.sessions ?? [],
      })
      console.debug(`[channel] loaded agent sessions advisor=${props.advisor} count=${data?.sessions?.length ?? 0}`)
    } catch (error) {
      console.warn(`[channel] agent sessions failed advisor=${props.advisor} error=${String(error)}`)
      setState({ supported: false, sessions: [] })
    } finally {
      setState("loading", false)
    }
  })

  const select = async (item: AgentSessionItem | undefined) => {
    if (!item || item.id === selected()?.id) return
    setSelected(item)
    const cached = previewCache.get(item.id)
    if (cached) {
      setPreview({ loading: false, failed: false, unavailable: cached.unavailable, messages: cached.messages })
      return
    }
    setPreview({ loading: true, failed: false, unavailable: undefined, messages: [] })
    try {
      const result = await sdk.client.agentBackend.agentSessionPreview({
        advisor: props.advisor as ChannelID,
        sessionID: item.id,
      })
      const messages = result.data?.messages ?? []
      const unavailable = result.data?.unavailable
      previewCache.set(item.id, { messages, unavailable })
      if (selected()?.id === item.id) setPreview({ loading: false, failed: false, unavailable, messages })
    } catch (error) {
      console.warn(
        `[channel] session preview failed advisor=${props.advisor} agentSession=${item.id} error=${String(error)}`,
      )
      if (selected()?.id === item.id) setPreview({ loading: false, failed: true, messages: [] })
    }
  }

  const pick = async (item: AgentSessionItem) => {
    if (state.busy) return
    setState("busy", item.id)
    try {
      const directory = sdk.directory
      const createSession = sdk.client.session.create.bind(sdk.client.session) as (
        parameters?: undefined,
        options?: {
          body?: {
            title?: string
            channel?: { kind: "acp"; advisor: string; model?: string; mode?: string; acpSessionID?: string }
          }
        },
      ) => Promise<{ data?: Session }>
      const session = await createSession(undefined, {
        body: {
          title: item.name,
          channel: {
            kind: "acp",
            advisor: props.advisor,
            acpSessionID: item.id,
            ...(props.model ? { model: props.model } : {}),
            ...(props.mode ? { mode: props.mode } : {}),
          },
        },
      }).then((x) => x.data)
      if (!session) return
      console.debug(
        `[channel] bound agent session advisor=${props.advisor} agentSession=${item.id} session=${session.id}`,
      )
      sync.session.created({ directory, info: session })
      // Warm the channel process so `session/load` replays the agent history into messages.
      void sdk.client.session
        .channel({ sessionID: session.id })
        .catch((error) => console.warn(`[channel] warm failed session=${session.id} error=${String(error)}`))
      const draft = layout.sessionBar.drafts().find((item) => item.id === params.draftID)
      if (draft) {
        const active = !params.id && params.draftID === draft.id
        if (active) layout.handoff.setTabs(base64Encode(directory), session.id, draft.id, base64Encode(directory))
        sessionTabs.promoteDraft({ directory, id: session.id }, draft)
      } else {
        sessionTabs.ensureOpen({ directory, id: session.id })
      }
      dialog.close()
      navigate(`/${base64Encode(directory)}/session/${session.id}`)
    } catch (error) {
      console.warn(`[channel] load agent session failed advisor=${props.advisor} error=${String(error)}`)
      setState("busy", undefined)
    }
  }

  const items = createMemo<AgentSessionItem[]>(() =>
    state.sessions
      .map((session) => ({
        id: session.id,
        name: session.title ?? session.id,
        updated: session.updated,
      }))
      .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "")),
  )

  const emptyMessage = () =>
    state.loading
      ? language.t("prompt.channel.sessions.loading")
      : state.supported
        ? language.t("prompt.channel.sessions.empty")
        : language.t("prompt.channel.sessions.unsupported")

  return (
    <Dialog
      title={
        <span class="flex items-center gap-2.5">
          <span>{language.t("prompt.channel.sessions")}</span>
          <Tag
            size="large"
            class="inline-flex items-center gap-1.5 rounded-full"
            style={{
              "border-color": `color-mix(in srgb, ${CHANNEL_COLORS[props.advisor] ?? "var(--icon-weak-base)"} 40%, transparent)`,
              "background-color": `color-mix(in srgb, ${CHANNEL_COLORS[props.advisor] ?? "var(--icon-weak-base)"} 10%, transparent)`,
              color: CHANNEL_COLORS[props.advisor] ?? "var(--text-weak)",
            }}
          >
            <ChannelIcon id={props.advisor} class="size-4 shrink-0" />
            <span>{CHANNEL_LABELS[props.advisor] ?? props.advisor}</span>
          </Tag>
        </span>
      }
      description={<span class="truncate">{sdk.directory}</span>}
      containerStyle={{
        height: "min(calc(100vh - 16px), 600px)",
        width: selected() ? "min(calc(100vw - 32px), 1080px)" : "min(calc(100vw - 32px), 520px)",
      }}
      class="flex min-h-0 flex-col"
    >
      <Show
        when={!state.loading}
        fallback={
          <div data-component="agent-session-loading" class="flex min-h-[320px] flex-1 items-center justify-center">
            <TextShimmer class="text-14-regular" text={language.t("prompt.channel.sessions.loading")} />
          </div>
        }
      >
        <div class="flex min-h-0 flex-1">
          <div
            data-component="agent-sessions-list"
            classList={{
              "flex min-w-0 flex-col": true,
              "w-[520px] shrink-0 border-r border-border-weak-base": !!selected(),
              "flex-1": !selected(),
            }}
          >
            <List
              class="flex-1 min-h-0 [&_[data-slot=list-viewport]]:flex-1 [&_[data-slot=list-viewport]]:min-h-0"
              virtual={false}
              search={{ placeholder: language.t("prompt.channel.sessions.search"), autofocus: true }}
              emptyMessage={emptyMessage()}
              key={(item) => item.id}
              items={items()}
              current={selected()}
              filterKeys={["name"]}
              onSelect={(item) => void select(item)}
            >
              {(item) => (
                <div class="flex min-w-0 flex-1 items-start gap-x-2.5 text-left">
                  <ChannelIcon id={props.advisor} class="mt-[7px] size-3.5 shrink-0" />
                  <div class="min-w-0 flex-1 text-left">
                    <div class="truncate text-14-medium text-text-strong">{item.name}</div>
                    <Show when={item.updated}>
                      <div class="mt-0.5 truncate text-12-regular text-text-weak">
                        {new Date(item.updated!).toLocaleString()}
                      </div>
                    </Show>
                  </div>
                  <Show when={state.busy === item.id}>
                    <Icon name="refresh" size="small" class="shrink-0 animate-spin" />
                  </Show>
                </div>
              )}
            </List>
          </div>
          <Show when={selected()}>
            {(item) => (
              <div class="flex min-w-0 flex-1 flex-col">
                <div class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3">
                  <Show
                    when={!preview.loading}
                    fallback={
                      <div class="flex flex-1 items-center justify-center">
                        <TextShimmer
                          class="text-13-regular"
                          text={language.t("prompt.channel.sessions.preview.loading")}
                        />
                      </div>
                    }
                  >
                    <For each={preview.messages}>
                      {(message) => (
                        <div
                          class="rounded-lg px-3 py-2"
                          style={{
                            "background-color":
                              message.kind === "user"
                                ? `color-mix(in srgb, ${CHANNEL_COLORS[props.advisor] ?? "var(--icon-weak-base)"} 12%, transparent)`
                                : "var(--surface-raised-base)",
                          }}
                        >
                          <div class="text-11-medium text-text-weak">
                            {message.kind === "user"
                              ? language.t("prompt.channel.sessions.preview.you")
                              : (CHANNEL_LABELS[props.advisor] ?? props.advisor)}
                          </div>
                          <div class="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-13-regular text-text-base">
                            {message.text}
                          </div>
                        </div>
                      )}
                    </For>
                    <Show when={preview.messages.length === 0}>
                      <div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center text-13-regular text-text-weak">
                        <span>
                          {language.t(
                            preview.unavailable
                              ? "prompt.channel.sessions.preview.unavailable"
                              : preview.failed
                                ? "prompt.channel.sessions.preview.failed"
                                : "prompt.channel.sessions.preview.empty",
                          )}
                        </span>
                        <Show when={preview.unavailable}>
                          {(reason) => (
                            <span class="break-all text-12-regular text-text-weak opacity-70">{reason()}</span>
                          )}
                        </Show>
                      </div>
                    </Show>
                  </Show>
                </div>
                <div class="flex items-center justify-end gap-2 px-4 py-3">
                  <Button
                    type="button"
                    variant="primary"
                    disabled={!!state.busy || !!preview.unavailable}
                    onClick={() => void pick(item())}
                  >
                    <Show when={state.busy === item().id}>
                      <Icon name="refresh" size="small" class="shrink-0 animate-spin" />
                    </Show>
                    <span>{language.t("prompt.channel.sessions.open")}</span>
                  </Button>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Show>
    </Dialog>
  )
}
