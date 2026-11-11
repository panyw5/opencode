import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import { Popover as Kobalte } from "@kobalte/core/popover"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { List } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"

export const CHANNEL_IDS = ["codex", "claude", "grok", "dsh", "pi"] as const
type ChannelID = (typeof CHANNEL_IDS)[number]
export const CHANNEL_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok",
  dsh: "DSH",
  pi: "Pi",
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

/** Advisors that can actually drive a session: ACP configured with a command. */
export function readyChannels(config?: { agent_backends?: Record<string, BackendConfig | undefined> }) {
  return CHANNEL_IDS.filter((id) => {
    const backend = config?.agent_backends?.[id]
    return backend?.type === "acp" && !!backend.command?.[0]?.trim()
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
              style={{ height: "40px", "padding-inline": "16px", "font-size": "15px", gap: "8px" }}
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
  triggerStyle?: JSX.CSSProperties
  class?: string
  compact?: boolean
}) {
  const sdk = useSDK()
  const language = useLanguage()
  const [state, setState] = createStore<{
    loading: boolean
    loaded: boolean
    current?: string
    options: Array<{ id: string; name: string }>
  }>({ loading: false, loaded: false, options: [] })
  const [revision, setRevision] = createSignal(0)

  const load = async () => {
    if (state.loaded || state.loading) return
    if (!props.sessionID && !props.advisor) return
    setState("loading", true)
    const target = props.sessionID ? `session=${props.sessionID}` : `advisor=${props.advisor}`
    console.debug(`[channel] loading model options ${target}`)
    try {
      const result = props.sessionID
        ? await sdk.client.session.channel({ sessionID: props.sessionID })
        : await sdk.client.agentBackend.channelOptions({ advisor: props.advisor as ChannelID })
      const data = result.data
      if (data) {
        setState({
          options: data.models ?? [],
          current: props.sessionID ? data.model : (props.draftModel ?? data.model),
          loaded: true,
        })
        console.debug(`[channel] loaded model options ${target} count=${data.models?.length ?? 0}`)
      }
    } catch (error) {
      console.warn(`[channel] model options failed ${target} error=${String(error)}`)
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

  const models = createMemo(() => {
    revision()
    return state.options
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
  const [open, setOpen] = createSignal(false)
  // Retry a failed or empty load when the menu is opened again.
  const retry = () => {
    if (state.loading || (state.loaded && state.options.length)) return
    setState("loaded", false)
    void load()
  }
  const label = () => CHANNEL_LABELS[props.advisor!] ?? props.advisor

  return (
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
  )
}
