import type {
  Message,
  Part,
  PermissionRequest,
  ProviderListResponse,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, For, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store"
import { useCommand } from "@/context/command"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import type { State } from "@/context/global-sync/types"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useModels } from "@/context/models"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"
import { focusCommandScope } from "@/context/command-focus"
import { working } from "@/pages/session/session-working"
import {
  sessionPermissionRequests,
  sessionQuestionRequests,
  sessionTreeIDs,
} from "@/pages/session/composer/session-request-tree"
import {
  domainFromDirectory,
  extraAgentCapabilities,
  mainDomain,
  type ExtraAgentCapabilities,
} from "@/pages/layout/extra-agents"
import { formatServerError } from "@/utils/server-errors"
import {
  collectSessionContext,
  context,
  fullSessionContextMessages,
  isSessionNotFoundError,
  loadQuickRequestSessions,
  mergeMessages,
  patchAgentQuestionDeny,
  prompt,
  removeQuickRequest,
  resolveQuickSession,
  splitInjectedSessionContext,
} from "./helpers"
import { QuickAssistantInput } from "./input"
import { QuickAssistantMessages } from "./messages"
import { QuickAssistantRequests } from "./requests"
import { type Prompt, type ImageAttachmentPart } from "@/context/prompt"
import { emptyQuickPrompt, quickPromptText, recoverQuickPrompt } from "./editor-model"
import { buildRequestParts } from "../prompt-input/build-request-parts"
import { promptText } from "../prompt-input/prompt-text"
import { clonePromptParts } from "../prompt-input/history"
import { QUICK_ASSISTANT_SELECTION_EVENT, appendSelectionToPrompt } from "@/utils/selection-prompt"
import {
  activeAfterClose,
  assistantWindowTitle,
  initialAssistantWindows,
  migrateAssistantWindows,
  type AssistantWindow,
} from "./windows"

function errorName(err: unknown) {
  if (!err || typeof err !== "object") return undefined
  const value = err as { name?: unknown }
  return typeof value.name === "string" ? value.name : undefined
}

type Pick = {
  agent: string
  model: {
    providerID: string
    modelID: string
  }
}

type AgentPick = State["agent"][number]
const QUICK_AGENT = "assistant"
const QUICK_ASSISTANT_MESSAGE_LIMIT = 80
const QUICK_ASSISTANT_SETTLE_MS = 3_000
const QUICK_ASSISTANT_STALE_MS = 300_000
const QUICK_ASSISTANT_EXIT_MS = 220

type WindowControls = {
  stop: () => Promise<boolean>
  select: (text: string) => void
}

function quickAssistantConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
    instructions: [],
    plugin: [],
    skills: {
      paths: [],
      urls: [],
    },
    agent: {
      build: { permission: { question: "allow" } },
      plan: { permission: { question: "allow" } },
    },
  }
}

function patchQuickAssistantConfig(existing: string | null) {
  if (existing === null) return JSON.stringify(quickAssistantConfig(), null, 2)
  let parsed: unknown
  try {
    parsed = JSON.parse(existing)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  const root = parsed as Record<string, unknown>
  const agent = root.agent && typeof root.agent === "object" && !Array.isArray(root.agent) ? root.agent : {}
  const next = {
    ...root,
    agent: {
      ...agent,
      build: patchAgentQuestionDeny((agent as Record<string, unknown>).build),
      plan: patchAgentQuestionDeny((agent as Record<string, unknown>).plan),
    },
  }
  const text = JSON.stringify(next, null, 2)
  return text === existing ? undefined : text
}

function validModel(store: State, model: { providerID: string; modelID: string } | undefined) {
  if (!model) return true
  const provider = store.provider.all.find((item) => item.id === model.providerID)
  if (!provider) return false
  if (!store.provider.connected.includes(model.providerID)) return false
  return !!provider.models[model.modelID]
}

function pickAgent(store: State) {
  const all = store.agent.filter((item) => item.mode !== "subagent")
  const quick = all.find((item) => item.name === QUICK_AGENT)
  if (quick && validModel(store, quick.model)) return quick
  const list = all.filter((item) => !item.hidden)
  if (list.length === 0) return
  const preferred = list.find((item) => item.name === store.config.default_agent)
  if (preferred && validModel(store, preferred.model)) return preferred
  return list.find((item) => validModel(store, item.model)) ?? preferred ?? list[0]
}

function choose(
  store: State,
  preferredModel: { providerID: string; modelID: string } | undefined,
  override?: ExtraAgentCapabilities["agentChoose"],
) {
  if (override) {
    return {
      agent: override.agent,
      model: override.model,
    } satisfies Pick
  }

  const item = pickAgent(store)
  const agent = item?.name
  if (!agent) return

  if (preferredModel && validModel(store, preferredModel)) {
    return {
      agent,
      model: preferredModel,
    } satisfies Pick
  }

  const connected = new Set(store.provider.connected)
  const configured = store.config.model?.split("/")
  if (configured?.length === 2) {
    const [providerID, modelID] = configured
    const provider = store.provider.all.find((item) => item.id === providerID)
    if (provider?.models[modelID] && connected.has(providerID)) {
      return {
        agent,
        model: { providerID, modelID },
      } satisfies Pick
    }
  }

  const model = pickModel(store.provider, connected)
  if (!model) return
  return {
    agent,
    model,
  } satisfies Pick
}

function pickModel(provider: ProviderListResponse, connected: Set<string>) {
  for (const item of provider.all) {
    if (!connected.has(item.id)) continue
    const preferred = provider.default[item.id]
    if (preferred && item.models[preferred]) {
      return {
        providerID: item.id,
        modelID: preferred,
      }
    }
    const first = Object.values(item.models)[0]
    if (!first) continue
    return {
      providerID: item.id,
      modelID: first.id,
    }
  }
}

function seed(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list: Session[]) => {
    const result = Binary.search(list, session.id, (item) => item.id)
    const next = [...list]
    if (result.found) {
      next[result.index] = session
      return next
    }
    next.splice(result.index, 0, session)
    return next
  })
}

function join(root: string, child: string) {
  const slash = /^[A-Za-z]:\\|\\\\/.test(root) || root.includes("\\") ? "\\" : "/"
  return root.replace(/[\\/]+$/, "") + slash + child
}

function native(dir: string, win: boolean) {
  if (!dir) return dir
  return win ? dir.replace(/\//g, "\\") : dir.replace(/\\/g, "/")
}

function same(a: string, b: string, win: boolean) {
  if (win) return native(a, true).toLowerCase() === native(b, true).toLowerCase()
  return native(a, false) === native(b, false)
}

export function QuickAssistant() {
  const platform = usePlatform()
  if (platform.platform !== "desktop") return null
  const params = useParams()
  const language = useLanguage()
  const settings = useSettings()
  const command = useCommand()
  const [saved, setSaved, , ready] = persisted(
    { ...Persist.global("quick-assistant", ["quick-assistant.v1"]), migrate: migrateAssistantWindows },
    createStore(initialAssistantWindows()),
  )
  const [status, setStatus] = createStore<
    Record<string, { busy: boolean; waiting: boolean; closing: boolean } | undefined>
  >({})
  const [panel, setPanel] = createStore({ present: false, entering: false, tabScroll: 0 })
  createEffect(() => {
    if (saved.open) {
      console.debug("[quick-assistant] panel slide-in requested motion=always")
      const entering = !untrack(() => panel.present)
      setPanel({ present: true, entering })
      if (!entering) return
      // Paint the off-screen position before transitioning in, without replaying on tab switches.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => setPanel("entering", false))
      })
      onCleanup(() => cancelAnimationFrame(frame))
      return
    }
    console.debug("[quick-assistant] panel slide-out requested motion=always")
    setPanel("entering", false)
    // Leave enough time for the 180ms CSS exit transition before removing the UI.
    const timer = setTimeout(() => {
      console.debug("[quick-assistant] panel slide-out complete; unmounting UI")
      setPanel({ present: false, tabScroll: 0 })
    }, QUICK_ASSISTANT_EXIT_MS)
    onCleanup(() => clearTimeout(timer))
  })
  const controls = new Map<string, WindowControls>()
  const enabled = () => settings.assistant.model() !== "disabled"
  const add = () => {
    if (!ready()) return
    const current = document.querySelector<HTMLElement>('[data-component="quick-assistant-panel"]:not([hidden])')
    const list = current?.querySelector<HTMLElement>('[data-component="quick-assistant-tabs"] [role="tablist"]')
    const height = current?.getBoundingClientRect().height
    const id = crypto.randomUUID()
    const number = saved.next
    batch(() => {
      setPanel("tabScroll", list?.scrollTop ?? 0)
      setSaved("windows", (items) => [...items, { id, number, context: false }])
      setSaved("active", id)
      setSaved("next", number + 1)
      setSaved("open", true)
    })
    console.debug(
      `[quick-assistant] window added window=${id} number=${number} count=${saved.windows.length} preservedHeight=${height ?? 0} tabScroll=${panel.tabScroll}`,
    )
  }
  const open = () => {
    if (!ready()) return
    if (!saved.windows.length) return add()
    setSaved("open", true)
    console.debug(`[quick-assistant] windows opened active=${saved.active} count=${saved.windows.length}`)
  }
  const close = async (id: string) => {
    if (status[id]?.closing) return
    setStatus(id, "closing", true)
    console.debug(`[quick-assistant] window close start window=${id}`)
    try {
      const control = controls.get(id)
      if (control && !(await control.stop())) return
      if (saved.windows.length === 1 && saved.open) {
        setSaved("open", false)
        await new Promise((resolve) => setTimeout(resolve, QUICK_ASSISTANT_EXIT_MS))
      }
      batch(() => {
        setSaved("active", activeAfterClose(saved.windows, saved.active, id))
        setSaved("windows", (items) => items.filter((item) => item.id !== id))
        if (!saved.windows.length) setSaved("open", false)
      })
      console.debug(
        `[quick-assistant] window closed window=${id} active=${saved.active ?? "none"} count=${saved.windows.length}`,
      )
    } finally {
      if (saved.windows.some((item) => item.id === id)) setStatus(id, "closing", false)
      else setStatus(id, undefined)
    }
  }
  const onSelection = (event: Event) => {
    const text = (event as CustomEvent<unknown>).detail
    if (typeof text !== "string" || !text.trim()) {
      console.warn(`[session-selection] quick assistant ignored invalid selection type=${typeof text}`)
      return
    }
    if (!ready()) {
      console.debug("[session-selection] quick assistant ignored selection reason=storage-loading")
      return
    }
    if (!saved.windows.length) add()
    controls.get(saved.active ?? "")?.select(text)
    open()
  }
  window.addEventListener(QUICK_ASSISTANT_SELECTION_EVENT, onSelection)
  console.debug("[session-selection] quick assistant listener enabled")
  onCleanup(() => {
    window.removeEventListener(QUICK_ASSISTANT_SELECTION_EVENT, onSelection)
    console.debug("[session-selection] quick assistant listener disabled")
  })
  command.register("quick-assistant", () => [
    {
      id: "assistant.quick.toggle",
      title: language.t("command.assistant.quick.toggle"),
      description: language.t("command.assistant.quick.toggle.description"),
      keywords: `${language.t("command.assistant.quick.toggle")} ${language.t("command.assistant.quick.toggle.description")}`,
      category: language.t("command.category.session"),
      keybind: "mod+shift+j",
      disabled: !enabled() || !ready(),
      onSelect: () => (saved.open ? setSaved("open", false) : open()),
    },
  ])
  const updateTabJoin = (list: HTMLElement) => {
    const panel = list.closest<HTMLElement>('[data-component="quick-assistant-panel"]')
    const outline = panel?.querySelector<HTMLElement>('[data-slot="quick-assistant-outline"]')
    const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!panel || !outline || !active) return
    const bounds = panel.getBoundingClientRect()
    const viewport = list.getBoundingClientRect()
    const tab = active.getBoundingClientRect()
    const start = Math.max(tab.top + 1, viewport.top) - bounds.top
    const end = Math.min(tab.bottom - 1, viewport.bottom) - bounds.top
    const join = panel.querySelector<HTMLElement>('[data-slot="quick-assistant-tab-join"]')
    if (join) {
      join.style.display = end > start ? "block" : "none"
      join.style.top = `${start - 1}px`
      join.style.height = `${Math.max(0, end - start)}px`
    }
    // Cut the border and its shadow together, without touching the translucent surface.
    const clip =
      end > start
        ? `polygon(-96px -96px, calc(100% + 96px) -96px, calc(100% + 96px) calc(100% + 96px), -96px calc(100% + 96px), -96px ${end}px, 2px ${end}px, 2px ${start}px, -96px ${start}px)`
        : "none"
    if (outline.style.clipPath === clip) return
    outline.style.clipPath = clip
    console.debug(
      `[quick-assistant] tab join window=${panel.dataset.windowId} start=${start} end=${end} visible=${end > start ? 1 : 0} background=${getComputedStyle(active).backgroundColor} panelBackground=${getComputedStyle(panel).backgroundColor}`,
    )
  }
  const tabs = () => (
    <div
      data-component="quick-assistant-tabs"
      class="absolute right-full top-8 mr-px flex w-36 max-sm:w-20 flex-col gap-1"
      style={{ "max-height": "calc(100% - 2rem)" }}
    >
      <div
        role="tablist"
        aria-label={language.t("quickAssistant.windows")}
        aria-orientation="vertical"
        class="flex min-h-0 min-w-0 flex-col gap-1 overflow-x-hidden overflow-y-auto"
        style={{ "overflow-anchor": "none" }}
        onScroll={(event) => {
          setPanel("tabScroll", event.currentTarget.scrollTop)
          updateTabJoin(event.currentTarget)
        }}
        ref={(node) => {
          const top = untrack(() => panel.tabScroll)
          const observer = new ResizeObserver(() => updateTabJoin(node))
          observer.observe(node)
          onCleanup(() => observer.disconnect())
          queueMicrotask(() => {
            if (!node.isConnected) return
            node.scrollTop = top
            const active = node.querySelector('[role="tab"][aria-selected="true"]')
            if (active) observer.observe(active)
            updateTabJoin(node)
          })
        }}
      >
        <For each={saved.windows}>
          {(item) => (
            <div class="group relative min-w-0 shrink-0">
              <button
                type="button"
                role="tab"
                id={`quick-assistant-tab-${item.id}`}
                aria-controls={`quick-assistant-window-${item.id}`}
                aria-selected={saved.active === item.id}
                aria-label={item.title || language.t("quickAssistant.window", { number: item.number })}
                title={item.title || language.t("quickAssistant.window", { number: item.number })}
                tabIndex={saved.active === item.id ? 0 : -1}
                class="relative isolate flex h-9 w-full min-w-0 items-center gap-2 rounded-l-full border border-r-0 border-border-weak-base bg-surface-base-active pl-3 pr-7 text-left text-12-medium text-text-weak transition-colors hover:bg-surface-base-hover aria-selected:text-text-strong max-sm:h-10 max-sm:pl-2"
                style={{
                  "background-color":
                    saved.active === item.id ? "var(--quick-assistant-surface)" : undefined,
                }}
                onClick={() => {
                  setSaved("active", item.id)
                  console.debug(`[quick-assistant] window selected window=${item.id}`)
                }}
                onKeyDown={(event) => {
                  const index = saved.windows.findIndex((tab) => tab.id === item.id)
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? saved.windows.length - 1
                        : event.key === "ArrowDown"
                          ? (index + 1) % saved.windows.length
                          : event.key === "ArrowUp"
                            ? (index + saved.windows.length - 1) % saved.windows.length
                            : undefined
                  if (next === undefined) return
                  event.preventDefault()
                  setSaved("active", saved.windows[next].id)
                  document.getElementById(`quick-assistant-tab-${saved.active}`)?.focus()
                }}
              >
                <Icon name="bubble-5" class="size-4 shrink-0 max-sm:hidden" />
                <span data-slot="quick-assistant-tab-title" class="min-w-0 truncate">
                  {item.title || language.t("quickAssistant.window", { number: item.number })}
                </span>
                <Show when={status[item.id]?.busy || status[item.id]?.waiting}>
                  <span
                    class="absolute bottom-1.5 right-1 size-1.5 rounded-full bg-success-base"
                    classList={{ "animate-pulse": status[item.id]?.busy }}
                  />
                </Show>
              </button>
              <button
                type="button"
                data-action="quick-assistant-close-window"
                class="absolute right-0.5 top-1/2 -translate-y-1/2 flex size-5 items-center justify-center rounded-full bg-transparent text-icon-weak hover:bg-surface-base-hover hover:text-icon-base disabled:opacity-40"
                aria-label={language.t("quickAssistant.window.close", { number: item.number })}
                title={language.t("quickAssistant.window.close", { number: item.number })}
                disabled={status[item.id]?.closing}
                onClick={() => void close(item.id)}
              >
                <Icon name="close" class="size-3" />
              </button>
            </div>
          )}
        </For>
      </div>
      <button
        type="button"
        data-action="quick-assistant-add-window"
        class="flex h-8 w-12 shrink-0 self-end items-center justify-center rounded-full border border-border-weak-base bg-background-stronger/95 text-icon-weak transition-colors hover:bg-surface-base-hover hover:text-icon-base"
        aria-label={language.t("quickAssistant.window.new")}
        title={language.t("quickAssistant.window.new")}
        onClick={add}
      >
        <Icon name="plus" class="size-4" />
      </button>
    </div>
  )
  return (
    <Show when={ready()}>
      <Show when={!saved.open && enabled() && params.dir}>
        <button
          type="button"
          data-component="quick-assistant-launcher"
          class="relative z-40 pointer-events-auto flex items-center gap-2 rounded-full border border-border-weak-base bg-background-stronger/95 px-3 py-2 shadow-[var(--shadow-lg-border-base)]"
          onClick={open}
        >
          <Icon name="bubble-5" class="size-4 text-icon-base" />
          <span class="text-12-medium text-text-strong">{language.t("quickAssistant.windows")}</span>
          <Show when={Object.values(status).some((item) => item?.busy || item?.waiting)}>
            <span class="size-2 rounded-full bg-success-base animate-pulse" />
          </Show>
        </button>
      </Show>
      {/* Keep drafts, recovery timers, and stream subscriptions alive across tab switches. */}
      <For each={saved.windows}>
        {(item) => (
          <QuickAssistantWindow
            saved={item}
            active={saved.active === item.id}
            open={saved.open}
            present={panel.present}
            entering={panel.entering}
            maximized={saved.maximized}
            primary={saved.windows[0]?.id === item.id}
            tabs={tabs}
            onOpen={open}
            onClose={() => setSaved("open", false)}
            onNew={add}
            onMaximize={() => setSaved("maximized", !saved.maximized)}
            onSession={(session) => setSaved("windows", (tab) => tab.id === item.id, "session", session)}
            onTitle={(title) => setSaved("windows", (tab) => tab.id === item.id, "title", title)}
            onContext={(context) => setSaved("windows", (tab) => tab.id === item.id, "context", context)}
            onVariant={(variant) => setSaved("windows", (tab) => tab.id === item.id, "variant", variant)}
            onStatus={(busy, waiting) =>
              setStatus(item.id, (previous) => ({ closing: previous?.closing ?? false, busy, waiting }))
            }
            register={(control) => {
              controls.set(item.id, control)
              return () => controls.delete(item.id)
            }}
          />
        )}
      </For>
    </Show>
  )
}

function QuickAssistantWindow(props: {
  saved: AssistantWindow
  active: boolean
  open: boolean
  present: boolean
  entering: boolean
  maximized: boolean
  primary: boolean
  tabs: () => JSX.Element
  onOpen: () => void
  onClose: () => void
  onNew: () => void
  onMaximize: () => void
  onSession: (id: string | undefined) => void
  onTitle: (title: string) => void
  onContext: (value: boolean) => void
  onVariant: (value: string | undefined) => void
  onStatus: (busy: boolean, waiting: boolean) => void
  register: (control: WindowControls) => () => void
}) {
  const params = useParams()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const server = useServer()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  const saved = props.saved
  const [state, setState] = createStore({
    prompt: emptyQuickPrompt(),
    history: [] as Prompt[],
    loading: false,
  })
  let input!: HTMLDivElement
  let sendSequence = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let staleTimer: ReturnType<typeof setTimeout> | undefined
  const win = createMemo(() => platform.os === "windows")

  const dir = createMemo(() => native(decode64(params.dir) ?? "", win()))
  const root = createMemo(() => {
    const base = globalSync.data.path.config
    if (!base) return ""
    return native(join(base, "quick-assistant"), win())
  })
  const activeDir = createMemo(() => {
    const current = dir()
    if (!current) return ""
    if (same(current, root(), win())) return ""
    return current
  })
  const agentChoose = createMemo(() => extraAgentCapabilities(server.current?.integration)?.agentChoose)
  const child = createMemo(() => {
    const next = root()
    if (!next) return
    return globalSync.child(next)
  })
  const data = createMemo(() => child()?.[0])
  const setData = createMemo(() => child()?.[1])
  const sessionID = createMemo(() => saved.session)
  const list = createMemo(() => {
    const id = sessionID()
    if (!id) return [] as Message[]
    return data()?.message[id] ?? []
  })
  const session = createMemo(() => data()?.session.find((item) => item.id === sessionID()))
  createEffect(() => {
    const current = root()
    const id = sessionID()
    if (!current || !id) return
    console.debug(`[quick-assistant] title metadata load window=${saved.id} session=${id}`)
    void globalSync.session.info
      .ensure(current, id)
      .catch((error) =>
        console.warn(
          `[quick-assistant] title metadata load failed window=${saved.id} session=${id} error=${String(error)}`,
        ),
      )
  })
  createEffect(() => {
    const first = list().find((item) => item.role === "user")
    const text = first
      ? (data()?.part[first.id] ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      : ""
    const title = assistantWindowTitle(session()?.title, splitInjectedSessionContext(text).message)
    if (!title || title === saved.title) return
    console.debug(
      `[quick-assistant] window title updated window=${saved.id} session=${sessionID() ?? "none"} chars=${title.length}`,
    )
    props.onTitle(title)
  })
  const busy = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return working(data()?.session_status[id], list())
  })
  const permissions = createMemo(() => {
    const store = data()
    return sessionPermissionRequests(store?.session ?? [], store?.permission ?? {}, sessionID())
  })
  const questions = createMemo(() => {
    const store = data()
    return sessionQuestionRequests(store?.session ?? [], store?.question ?? {}, sessionID())
  })
  createEffect(() => {
    const current = root()
    const store = data()
    if (!current || !sessionID() || !store) return
    const requests = [...Object.values(store.permission).flat(), ...Object.values(store.question).flat()]
    const known = new Map(store.session.map((session) => [session.id, session]))
    const missing = new Set<string>()
    for (const request of requests) {
      let id: string | undefined = request?.sessionID
      const seen = new Set<string>()
      while (id && !seen.has(id)) {
        seen.add(id)
        const session = known.get(id)
        if (!session) {
          missing.add(id)
          break
        }
        id = session.parentID
      }
    }
    if (!missing.size) return
    console.debug(`[quick-assistant] request ancestry load count=${missing.size}`)
    void loadQuickRequestSessions([...missing], (id) => globalSync.session.info.ensure(current, id)).catch((error) =>
      console.error(`[quick-assistant] request ancestry load failed error=${String(error)}`),
    )
  })
  createEffect(() => {
    console.debug(
      `[quick-assistant] pending tree requests window=${saved.id} session=${sessionID() ?? "none"} permissions=${permissions().length} questions=${questions().length}`,
    )
  })
  const waiting = createMemo(() => permissions().length > 0 || questions().length > 0)
  const interacting = createMemo(() => busy() || waiting())
  const titleAttempts = new Set<string>()
  createEffect(() => {
    const id = sessionID()
    const current = root()
    const setStore = setData()
    if (!props.open || !props.active || !id || !current || !setStore || busy() || state.loading) return
    // Older assistants were explicitly named, which disables normal backend auto-titling.
    if (session()?.title !== "Quick Assistant" || !list().some((item) => item.role === "user") || titleAttempts.has(id))
      return
    titleAttempts.add(id)
    console.debug(`[quick-assistant] legacy title generation start window=${saved.id} session=${id}`)
    void globalSDK
      .createClient({ directory: current, throwOnError: true })
      .session.generateTitle({ sessionID: id })
      .then((result) => {
        if (!result.data) return
        seed(setStore, result.data)
        console.debug(
          `[quick-assistant] legacy title generation complete window=${saved.id} session=${id} chars=${result.data.title.length}`,
        )
      })
      .catch((error) =>
        console.warn(
          `[quick-assistant] legacy title generation failed window=${saved.id} session=${id} error=${String(error)}`,
        ),
      )
  })
  createEffect(() => props.onStatus(busy() || state.loading, waiting()))
  const chosen = createMemo(() => {
    const store = data()
    const model = settings.assistant.model()
    if (!store || model === "disabled") return
    return choose(store, model === "auto" ? undefined : model, agentChoose())
  })
  const models = useModels()
  const variantList = createMemo(() => {
    const pick = chosen()?.model
    if (!pick) return []
    const item = models.find(pick)
    return item?.variants ? Object.keys(item.variants) : []
  })
  const effectiveVariant = createMemo(() => {
    const value = saved.variant
    if (!value) return undefined
    return variantList().includes(value) ? value : undefined
  })
  const setVariant = (value: string | undefined) => {
    console.debug(`[quick-assistant] variant ${value ? `set ${value}` : "cleared"}`)
    props.onVariant(value)
  }
  const currentChild = createMemo(() => {
    const current = activeDir()
    if (!current) return
    return globalSync.child(current, { bootstrap: false })
  })
  const currentData = createMemo(() => currentChild()?.[0])
  const currentSession = createMemo(() => {
    const id = params.id
    if (!id) return
    return currentData()?.session.find((item) => item.id === id)
  })

  const currentContext = createMemo(() => {
    const current = activeDir()
    const id = params.id
    if (!current || !id) return ""
    const session = currentSession()
    const messages = currentData()?.message[id] ?? []
    return context(current, id, session, messages.length)
  })

  const toggleContext = () => {
    const available = !!currentContext()
    if (!available) {
      console.debug("[quick-assistant] context toggle blocked reason=no-current-session")
      return
    }
    const next = !saved.context
    console.debug(
      `[quick-assistant] context ${next ? "enabled" : "disabled"} source_session=${params.id ?? ""} source_directory=${activeDir()}`,
    )
    props.onContext(next)
  }

  createEffect(() => {
    if (!props.primary) return
    const next = root()
    if (!next) return
    if (platform.platform !== "desktop") return
    if (!platform.readLocalFile || !platform.writeLocalFile) return
    const file = join(next, "opencode.json")
    platform.readLocalFile(file).then((existing) => {
      const patched = patchQuickAssistantConfig(existing)
      if (!patched) return
      return platform.writeLocalFile!(file, patched).then(async () => {
        console.info(`[quick-assistant] config migrated directory=${next}`)
        await globalSDK.createClient({ directory: next, throwOnError: true }).instance.dispose({ directory: next })
        console.info(`[quick-assistant] config runtime disposed directory=${next}`)
      })
    })
  })

  const clearSession = () => {
    const id = sessionID()
    if (!id) return
    const setStore = setData()
    props.onSession(undefined)
    if (!setStore) return
    batch(() => {
      setStore("session_status", (items) => {
        if (!(id in items)) return items
        const next = { ...items }
        delete next[id]
        return next
      })
      setStore("message", (items) => {
        if (!(id in items)) return items
        const next = { ...items }
        delete next[id]
        return next
      })
      setStore("permission", (items) => ({ ...items, [id]: [] }))
      setStore("question", (items) => ({ ...items, [id]: [] }))
    })
  }

  const clearTimers = () => {
    if (settleTimer) clearTimeout(settleTimer)
    if (staleTimer) clearTimeout(staleTimer)
    settleTimer = undefined
    staleTimer = undefined
  }

  const refreshSession = async (
    client: ReturnType<typeof globalSDK.createClient>,
    id: string,
    setStore: SetStoreFunction<State>,
  ) => {
    const [statusResult, messageResult, permissionResult, questionResult] = await Promise.allSettled([
      client.session.status(),
      globalSync.session.messages.page({ directory: root(), sessionID: id, limit: QUICK_ASSISTANT_MESSAGE_LIMIT }),
      client.permission.list(),
      client.question.list(),
    ])
    if (statusResult.status === "rejected" && isSessionNotFoundError(statusResult.reason)) throw statusResult.reason
    if (messageResult.status === "rejected" && isSessionNotFoundError(messageResult.reason)) throw messageResult.reason

    const pendingPermissions = permissionResult.status === "fulfilled" ? (permissionResult.value.data ?? []) : []
    const pendingQuestions = questionResult.status === "fulfilled" ? (questionResult.value.data ?? []) : []
    // Reloaded windows may have missed session.created for a blocked subagent.
    await loadQuickRequestSessions(
      [...pendingPermissions, ...pendingQuestions].map((request) => request.sessionID),
      (sessionID) => globalSync.session.info.ensure(root(), sessionID),
    )
    const tree = sessionTreeIDs(data()?.session ?? [], id)
    console.debug(`[quick-assistant] requests refreshed session=${id} tree=${tree.length}`)

    batch(() => {
      if (statusResult.status === "fulfilled") {
        const next = statusResult.value.data?.[id] ?? { type: "idle" as const }
        setStore("session_status", id, next)
      }

      if (messageResult.status === "fulfilled") {
        const message = messageResult.value.session
        const next = mergeMessages(data()?.message[id], message)
        setStore("message", id, reconcile(next, { key: "id" }))
        for (const item of messageResult.value.part) {
          setStore("part", item.id, item.part)
        }
      }
      if (permissionResult.status === "fulfilled") {
        for (const sessionID of tree)
          setStore(
            "permission",
            sessionID,
            pendingPermissions.filter((item) => item.sessionID === sessionID),
          )
      }
      if (questionResult.status === "fulfilled") {
        for (const sessionID of tree)
          setStore(
            "question",
            sessionID,
            pendingQuestions.filter((item) => item.sessionID === sessionID),
          )
      }
    })
  }

  const lastCompletedAssistant = (id: string) => {
    const last = data()?.message[id]?.at(-1)
    if (!last || last.role !== "assistant") return false
    return typeof last.time.completed === "number"
  }

  const completePendingAssistant = (id: string, setStore: SetStoreFunction<State>) => {
    const messages = data()?.message[id]
    if (!messages) return
    const last = messages?.at(-1)
    if (!last || last.role !== "assistant") return
    if (typeof last.time.completed === "number") return
    setStore("message", id, messages.length - 1, "time", {
      ...last.time,
      completed: Date.now(),
    })
  }

  const markIdle = (id: string, setStore: SetStoreFunction<State>) => {
    batch(() => {
      setStore("session_status", id, { type: "idle" })
      completePendingAssistant(id, setStore)
    })
  }

  const finishIfSettled = (id: string, completedReplyOnly = false) => {
    if (sessionID() !== id) return
    if (completedReplyOnly && !lastCompletedAssistant(id)) return
    const current = data()
    if (working(current?.session_status[id], current?.message[id]) || waiting()) return
    clearTimers()
  }

  const scheduleRecovery = (
    client: ReturnType<typeof globalSDK.createClient>,
    id: string,
    setStore: SetStoreFunction<State>,
  ) => {
    clearTimers()
    settleTimer = setTimeout(() => {
      if (sessionID() !== id) return
      refreshSession(client, id, setStore)
        .then(() => {
          if (data()?.session_status[id]?.type === "idle" && !waiting()) markIdle(id, setStore)
          finishIfSettled(id)
        })
        .catch((err: unknown) => {
          if (isSessionNotFoundError(err)) {
            clearSession()
          }
        })
    }, QUICK_ASSISTANT_SETTLE_MS)

    staleTimer = setTimeout(() => {
      if (sessionID() !== id) return
      refreshSession(client, id, setStore)
        .catch((err: unknown) => {
          if (isSessionNotFoundError(err)) clearSession()
        })
        .finally(() => {
          if (sessionID() !== id) return
          const current = data()
          if (!working(current?.session_status[id], current?.message[id]) || waiting()) {
            return
          }
          console.debug(`[quick-assistant] stale busy state cleared session=${id}`)
          markIdle(id, setStore)
        })
    }, QUICK_ASSISTANT_STALE_MS)
  }

  onCleanup(clearTimers)

  const select = (text: string) => {
    console.debug(`[session-selection] quick assistant received window=${saved.id} length=${text.length}`)
    const next = appendSelectionToPrompt(state.prompt, text)
    setState("prompt", reconcile(next.prompt))
    console.debug(`[session-selection] quick assistant prompt updated window=${saved.id} cursor=${next.cursor}`)
  }

  const ensureSession = async (
    client: ReturnType<typeof globalSDK.createClient>,
    setStore: SetStoreFunction<State>,
  ) => {
    console.debug(`[quick-assistant] session validation start session=${sessionID() ?? "none"}`)
    const resolved = await resolveQuickSession({
      sessionID: sessionID(),
      load: (id) => client.session.get({ sessionID: id }).then((result) => result.data),
      create: () => client.session.create().then((result) => result.data),
      unavailable: (id, reason) => {
        console.warn(`[quick-assistant] session unavailable session=${id} reason=${reason}; replacing`)
        clearSession()
      },
    })
    const created = resolved.session
    if (!created) return
    console.debug(`[quick-assistant] session validated session=${created.id} created=${resolved.created ? 1 : 0}`)
    if (!resolved.created) return created.id
    seed(setStore, created)
    props.onSession(created.id)
    return created.id
  }

  const close = () => {
    console.debug("[quick-assistant] panel closed")
    props.onClose()
  }

  const toggleMaximize = () => {
    const next = !props.maximized
    console.debug(`[quick-assistant] maximize ${next ? "enabled" : "disabled"} messages=${list().length}`)
    props.onMaximize()
  }

  const stop = async () => {
    sendSequence += 1
    const current = root()
    const id = sessionID()
    const setStore = setData()
    console.debug(
      `[quick-assistant] stop start busy=${busy() ? 1 : 0} session=${id ?? ""} draft=${quickPromptText(state.prompt).length}`,
    )
    if (current && id && interacting()) {
      const aborted = await globalSDK
        .createClient({ directory: current, throwOnError: true })
        .session.abort({ sessionID: id })
        .then(() => {
          console.debug(`[quick-assistant] stop acknowledged session=${id}`)
          return true
        })
        .catch((err: unknown) => {
          console.error(`[quick-assistant] stop failed session=${id} error=${String(err)}`)
          showToast({
            title: "Quick Assistant",
            description: formatServerError(err, language.t, language.t("common.requestFailed")),
          })
          return false
        })
      if (!aborted) return false
      if (setStore) markIdle(id, setStore)
    }
    clearTimers()
    setState("loading", false)
    console.debug(`[quick-assistant] stop complete session=${id ?? ""} draft=${quickPromptText(state.prompt).length}`)
    return true
  }

  onCleanup(props.register({ stop, select }))
  onCleanup(() => {
    sendSequence += 1
  })

  createEffect(() => {
    if (!props.open || !props.active) return
    queueMicrotask(() => {
      if (!props.open || !props.active) return
      if (document.activeElement?.closest('[data-component="quick-assistant-tabs"]')) return
      input?.focus()
    })
  })

  createEffect(() => {
    const current = root()
    const id = sessionID()
    const store = data()
    const setStore = setData()
    if (!current || !id || !store || !setStore) return
    if (store.message[id] !== undefined && store.permission[id] !== undefined && store.question[id] !== undefined)
      return
    const client = globalSDK.createClient({ directory: current, throwOnError: true })
    refreshSession(client, id, setStore).catch((err: unknown) => {
      if (isSessionNotFoundError(err)) {
        clearSession()
        return
      }
    })
  })

  createEffect(() => {
    const current = root()
    const id = sessionID()
    const setStore = setData()
    if (!current || !id || !setStore) return

    const off = globalSDK.eventFor(domainFromDirectory(current)).listen((e) => {
      if (!same(e.name, current, win())) return
      const event = e.details
      if (event.type === "session.status") {
        if (event.properties.sessionID !== id) return
        setStore("session_status", id, event.properties.status)
        console.debug(
          `[quick-assistant] stream status session=${id} status=${event.properties.status.type} sending=${state.loading ? 1 : 0}`,
        )
        if (event.properties.status.type === "idle" && !waiting()) {
          completePendingAssistant(id, setStore)
          clearTimers()
        }
        return
      }

      if (event.type === "session.idle") {
        if (event.properties.sessionID !== id) return
        if (!waiting()) markIdle(id, setStore)
        clearTimers()
        console.debug(`[quick-assistant] stream idle session=${id} draft=${quickPromptText(state.prompt).length}`)
        return
      }

      if (event.type !== "session.error") return
      if (event.properties.sessionID !== id) return
      markIdle(id, setStore)
      clearTimers()
      console.error(`[quick-assistant] stream error session=${id} error=${JSON.stringify(event.properties.error)}`)
      showToast({
        title: "Quick Assistant",
        description: formatServerError(event.properties.error, language.t, language.t("common.requestFailed")),
      })
    })

    onCleanup(off)
  })

  async function submit() {
    if (state.loading) {
      console.debug("[quick-assistant] prompt blocked reason=loading")
      return
    }
    if (waiting()) {
      console.debug(`[quick-assistant] prompt blocked waiting-request session=${sessionID() ?? ""}`)
      return
    }
    if (busy()) {
      console.debug(
        `[quick-assistant] prompt blocked reason=streaming session=${sessionID() ?? ""} draft=${quickPromptText(state.prompt).length}`,
      )
      return
    }
    const current = root()
    const draft = clonePromptParts(state.prompt)
    const text = quickPromptText(draft).trim()
    const images = draft.filter((part): part is ImageAttachmentPart => part.type === "image")
    const store = data()
    const setStore = setData()
    if (!current) {
      showToast({
        title: "Quick Assistant",
        description: "Quick Assistant is still starting.",
      })
      return
    }
    if (!text && images.length === 0) return
    if (!store || !setStore) return
    const pick = chosen()
    if (!pick) {
      showToast({
        title: "Quick Assistant",
        description: "Connect a model provider first.",
      })
      return
    }
    const variant = effectiveVariant()
    const sequence = ++sendSequence
    const activeSend = () => sequence === sendSequence
    const attachmentDirectory = activeDir() || current
    const restoreDraft = (stage: string) => {
      if (!activeSend()) return
      const recovered = recoverQuickPrompt(state.prompt, draft)
      if (recovered) setState("prompt", recovered)
      console.debug(
        `[quick-assistant] send draft recovery stage=${stage} restored=${recovered ? 1 : 0} draft=${quickPromptText(state.prompt).length}`,
      )
    }

    batch(() => {
      setState("loading", true)
      setState("history", (items) => [draft, ...items].slice(0, 100))
      setState("prompt", emptyQuickPrompt())
    })
    console.debug(`[quick-assistant] submitted draft cleared text=${quickPromptText(state.prompt).length} images=0`)
    console.debug(`[quick-assistant] send preparation start text=${text.length} images=${images.length}`)
    let body = promptText(draft).trim()
    if (saved.context) {
      const directory = activeDir()
      const sourceID = params.id
      if (!directory || !sourceID) {
        console.error("[quick-assistant] context load blocked reason=no-current-session")
        setState("loading", false)
        restoreDraft("context-unavailable")
        showToast({ title: "Quick Assistant", description: language.t("quickAssistant.context.loadFailed") })
        return
      }
      try {
        console.debug(`[quick-assistant] context load start source_session=${sourceID} directory=${directory}`)
        const source = globalSDK.forDomain(mainDomain).createClient({ directory, throwOnError: true })
        const snapshot = await collectSessionContext(async (before) => {
          const response = await source.session.messages({ sessionID: sourceID, limit: 100, before })
          const items = response.data ?? []
          const cursor = response.response.headers.get("x-next-cursor") ?? undefined
          console.debug(
            `[quick-assistant] context page source_session=${sourceID} before=${before ?? "none"} count=${items.length} next=${cursor ? 1 : 0}`,
          )
          return { items, cursor }
        })
        if (!activeSend()) return
        if (params.id !== sourceID || activeDir() !== directory || !saved.context) {
          console.debug(`[quick-assistant] context load discarded source_session=${sourceID} reason=input-changed`)
          setState("loading", false)
          restoreDraft("context-changed")
          return
        }
        const messages = fullSessionContextMessages(snapshot.items)
        body = prompt(
          promptText(draft).trim(),
          context(directory, sourceID, currentSession(), snapshot.items.length, {
            messages,
            complete: snapshot.complete,
          }),
          true,
        )
        console.debug(
          `[quick-assistant] context load complete source_session=${sourceID} pages=${snapshot.pages} fetched=${snapshot.items.length} included=${messages.length} complete=${snapshot.complete ? 1 : 0} chars=${body.length}`,
        )
      } catch (error) {
        if (!activeSend()) return
        console.error(`[quick-assistant] context load failed source_session=${sourceID} error=${String(error)}`)
        setState("loading", false)
        restoreDraft("context-failed")
        showToast({ title: "Quick Assistant", description: language.t("quickAssistant.context.loadFailed") })
        return
      }
    }
    console.debug(
      `[quick-assistant] submit context=${saved.context ? 1 : 0} text=${text.length} body=${body.length} model=${pick.model.providerID}/${pick.model.modelID} variant=${variant ?? "none"}`,
    )
    const client = globalSDK.createClient({ directory: current, throwOnError: true })
    const id = await ensureSession(client, setStore).catch((err: unknown) => {
      if (!activeSend()) return undefined
      console.error(`[quick-assistant] session setup failed error=${String(err)}`)
      showToast({
        title: "Quick Assistant",
        description: formatServerError(err, language.t, language.t("common.requestFailed")),
      })
      return undefined
    })
    if (!activeSend()) return

    if (!id) {
      setState("loading", false)
      restoreDraft("session-failed")
      return
    }

    const messageID = Identifier.ascending("message")
    const now = Date.now()
    const msg: Message = {
      id: messageID,
      sessionID: id,
      role: "user",
      time: { created: now },
      agent: pick.agent,
      model: { ...pick.model, variant },
    }
    // Mentions resolve against the visible project, not the assistant's private workspace.
    // Source offsets include any injected context and account for trimmed leading whitespace.
    const offset =
      body.length -
      promptText(draft).trim().length -
      (quickPromptText(draft).length - quickPromptText(draft).trimStart().length)
    const { requestParts, optimisticParts } = buildRequestParts({
      prompt: draft.map((part) =>
        part.type === "image" ? part : { ...part, start: part.start + offset, end: part.end + offset },
      ),
      images,
      context: [],
      text: body,
      messageID,
      sessionID: id,
      sessionDirectory: attachmentDirectory,
    })
    const invocation = text.match(/^\/([^\s]+)(?:\s([\s\S]*))?$/)
    const custom = invocation ? store.command.find((item) => item.name === invocation[1]) : undefined
    const commandContext = custom ? splitInjectedSessionContext(body).context : undefined
    console.debug(
      `[quick-assistant] request built window=${saved.id} session=${id} parts=${requestParts.map((part) => part.type).join(",")} command=${custom?.name ?? "none"}`,
    )

    batch(() => {
      setStore("session_status", id, { type: "busy" })
      setStore("message", (items) => {
        const list = items[id] ?? []
        const result = Binary.search(list, msg.id, (item) => item.id)
        const next = [...list]
        next.splice(result.index, 0, msg)
        return {
          ...items,
          [id]: next,
        }
      })
      setStore("part", messageID, optimisticParts)
    })
    console.debug(
      `[quick-assistant] send dispatched session=${id} message=${messageID} next_draft=${quickPromptText(state.prompt).length}`,
    )

    clearTimers()
    await (
      custom
        ? client.session.command({
            sessionID: id,
            messageID,
            command: custom.name,
            arguments: [commandContext, invocation?.[2]].filter(Boolean).join("\n\n"),
            agent: pick.agent,
            model: `${pick.model.providerID}/${pick.model.modelID}`,
            variant,
            parts: requestParts.filter((part) => part.type === "file"),
          })
        : client.session.promptAsync({
            sessionID: id,
            agent: pick.agent,
            model: pick.model,
            messageID,
            variant,
            tools: { question: true },
            parts: requestParts,
          })
    )
      .then(() =>
        console.debug(`[quick-assistant] request accepted window=${saved.id} session=${id} message=${messageID}`),
      )
      .catch((err: unknown) => {
        if (!activeSend()) {
          console.debug(`[quick-assistant] stale send failure ignored session=${id} message=${messageID}`)
          return
        }
        console.error(
          `[quick-assistant] request failed window=${saved.id} session=${id} message=${messageID} error=${String(err)}`,
        )
        const aborted = errorName(err) === "AbortError"
        if (!aborted) restoreDraft("request-failed")
        batch(() => {
          markIdle(id, setStore)
          if (aborted) {
            setStore("message", (items) => {
              const list = items[id] ?? []
              const result = Binary.search(list, messageID, (item) => item.id)
              if (!result.found) return items
              const next = [...list]
              next.splice(result.index, 1)
              return {
                ...items,
                [id]: next,
              }
            })
            setStore("part", (items: Record<string, Part[] | undefined>) => {
              if (!(messageID in items)) return items
              const next = { ...items }
              delete next[messageID]
              return next
            })
          }
        })
        showToast({
          title: "Quick Assistant",
          description: formatServerError(err, language.t, language.t("common.requestFailed")),
        })
      })
      .finally(() => {
        if (!activeSend()) return
        setState("loading", false)
        console.debug(
          `[quick-assistant] send transport settled session=${id} busy=${busy() ? 1 : 0} draft=${quickPromptText(state.prompt).length}`,
        )
      })

    if (!activeSend()) return
    scheduleRecovery(client, id, setStore)
    finishIfSettled(id)
  }

  const expanded = createMemo(() => props.maximized)

  const removePermission = (request: PermissionRequest) => {
    const setStore = setData()
    if (!setStore) return
    console.debug(`[quick-assistant] permission cleanup request=${request.id} session=${request.sessionID}`)
    setStore("permission", request.sessionID, (items) => removeQuickRequest(items, request.id))
  }

  const removeQuestion = (request: QuestionRequest) => {
    const setStore = setData()
    if (!setStore) return
    console.debug(`[quick-assistant] question cleanup request=${request.id} session=${request.sessionID}`)
    setStore("question", request.sessionID, (items) => removeQuickRequest(items, request.id))
  }

  return (
    <>
      <Show when={props.present}>
        <div
          data-component="quick-assistant-panel"
          data-state={props.open ? "open" : "closed"}
          data-entering={props.entering}
          inert={!props.open}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || event.propertyName !== "transform") return
            console.debug(`[quick-assistant] panel slide complete window=${saved.id} open=${props.open}`)
          }}
          data-window-id={saved.id}
          id={`quick-assistant-window-${saved.id}`}
          role="tabpanel"
          aria-labelledby={`quick-assistant-tab-${saved.id}`}
          hidden={!props.active}
          data-command-scope="quick-assistant"
          tabIndex={-1}
          onPointerDown={(event) => {
            if (event.button === 0 && !event.defaultPrevented) focusCommandScope(event.currentTarget, event.target)
          }}
          class="fixed right-5 bottom-5 z-40 pointer-events-auto h-[calc(100dvh-72px)] rounded-[calc(var(--radius-4xl)+0.75rem+1px)] border border-transparent outline-none"
          ref={(element) =>
            requestAnimationFrame(() => {
              if (!element.isConnected) return
              const composer = element.querySelector('[data-prompt-kind="quick"]')
              console.debug(
                `[quick-assistant] panel geometry empty=${list().length === 0 ? 1 : 0} height=${element.getBoundingClientRect().height} background=${getComputedStyle(element).backgroundColor} radius=${getComputedStyle(element).borderRadius} composerRadius=${composer ? getComputedStyle(composer).borderRadius : "none"} contentOverflow=${getComputedStyle(element.lastElementChild!).overflow}`,
              )
            })
          }
          classList={{
            "w-[min(1040px,calc(100vw-192px))] max-sm:w-[calc(100vw-128px)]": expanded(),
            "w-[min(520px,calc(100vw-192px))] max-sm:w-[calc(100vw-128px)]": !expanded(),
          }}
          style={{
            "--quick-assistant-surface":
              "color-mix(in srgb, var(--background-base) 20%, var(--background-stronger))",
            "background-color": "var(--quick-assistant-surface)",
          }}
        >
          <div
            data-slot="quick-assistant-outline"
            aria-hidden="true"
            class="pointer-events-none absolute -inset-px rounded-[inherit] border border-border-weak-base shadow-[var(--shadow-lg)]"
          />
          <div
            data-slot="quick-assistant-tab-join"
            aria-hidden="true"
            class="pointer-events-none absolute -left-px w-px"
            style={{
              display: "none",
              "background-color": "var(--quick-assistant-surface)",
            }}
          />
          <Show when={props.active}>{props.tabs()}</Show>
          <button
            type="button"
            class="absolute -top-3.5 right-5 z-10 flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base/90 text-icon-weak shadow-xs-border transition hover:border-border-strong-base hover:bg-surface-base-hover hover:text-icon-base"
            aria-label={language.t(expanded() ? "common.restore" : "common.maximize")}
            title={language.t(expanded() ? "common.restore" : "common.maximize")}
            onClick={toggleMaximize}
          >
            <Icon name={expanded() ? "collapse" : "expand"} size="small" class="text-icon-weak" />
          </button>
          <button
            type="button"
            class="absolute -right-3.5 -top-3.5 z-10 flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base/90 text-icon-weak shadow-xs-border transition hover:border-border-strong-base hover:bg-surface-base-hover hover:text-icon-base"
            data-action="quick-assistant-hide"
            aria-label={language.t("common.close")}
            title={language.t("common.close")}
            onClick={close}
          >
            <Icon name="close" size="small" class="text-icon-weak" />
          </button>
          <div class="flex h-full min-h-0 flex-col rounded-[inherit]">
            <QuickAssistantMessages fill list={list()} parts={data()?.part} busy={busy()} waiting={waiting()} />
            <QuickAssistantRequests
              client={globalSDK.createClient({ directory: root(), throwOnError: true })}
              permissions={permissions()}
              questions={questions()}
              onPermissionDone={removePermission}
              onQuestionDone={removeQuestion}
            />
            <Show when={!waiting()}>
              <QuickAssistantInput
                setRef={(next) => {
                  input = next
                }}
                prompt={state.prompt}
                history={state.history}
                directory={activeDir() || root()}
                scope={JSON.stringify([root(), saved.id, sessionID()])}
                agents={data()?.agent ?? []}
                commands={data()?.command ?? []}
                busy={interacting()}
                loading={state.loading}
                ready={!!root()}
                context={saved.context}
                contextAvailable={!!currentContext()}
                contextTitle={currentSession()?.title}
                variants={variantList()}
                variant={effectiveVariant()}
                onPrompt={(next) => setState("prompt", reconcile(next))}
                onClose={close}
                onStop={() => void stop()}
                onNewSession={props.onNew}
                onContext={toggleContext}
                onVariant={setVariant}
                onSend={() => void submit()}
              />
            </Show>
          </div>
        </div>
      </Show>
    </>
  )
}
