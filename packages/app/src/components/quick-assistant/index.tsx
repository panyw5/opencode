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
import { batch, createEffect, createMemo, onCleanup, onMount, Show } from "solid-js"
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
import { working } from "@/pages/session/session-working"
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
  mergeMessages,
  patchAgentQuestionDeny,
  prompt,
  removeQuickRequest,
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
import { appendSelectionToPrompt, QUICK_ASSISTANT_SELECTION_EVENT } from "@/utils/selection-prompt"

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

type Saved = {
  open: boolean
  session: Record<string, string | undefined>
  context: boolean
  maximized?: boolean
  variant?: string
}

const initial = {
  open: false,
  session: {},
  context: false,
  maximized: false,
} satisfies Saved

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

function patchSession(setStore: SetStoreFunction<State>, sessionID: string, next: Partial<Session>) {
  setStore("session", (list: Session[]) => {
    const result = Binary.search(list, sessionID, (item) => item.id)
    if (!result.found) return list
    const copy = [...list]
    copy[result.index] = {
      ...copy[result.index],
      ...next,
    }
    return copy
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
  const params = useParams()
  const command = useCommand()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const server = useServer()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()
  if (platform.platform !== "desktop") return null
  const [saved, setSaved] = persisted(
    Persist.global("quick-assistant", ["quick-assistant.v1"]),
    createStore<Saved>(initial),
  )
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
  const key = () => "__quick__"
  const sessionID = createMemo(() => saved.session[key()])
  const list = createMemo(() => {
    const id = sessionID()
    if (!id) return [] as Message[]
    return data()?.message[id] ?? []
  })
  const busy = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return working(data()?.session_status[id], list())
  })
  const permissions = createMemo(() => {
    const id = sessionID()
    return id ? (data()?.permission[id] ?? []) : []
  })
  const questions = createMemo(() => {
    const id = sessionID()
    return id ? (data()?.question[id] ?? []) : []
  })
  const waiting = createMemo(() => permissions().length > 0 || questions().length > 0)
  const interacting = createMemo(() => busy() || waiting())
  const enabled = createMemo(() => settings.assistant.model() !== "disabled")
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
    setSaved("variant", value)
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
    setSaved("context", next)
  }

  createEffect(() => {
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
    setSaved("session", key(), undefined)
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
        setStore("permission", id, permissionResult.value.data?.filter((item) => item.sessionID === id) ?? [])
      }
      if (questionResult.status === "fulfilled") {
        setStore("question", id, questionResult.value.data?.filter((item) => item.sessionID === id) ?? [])
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

  const ensureSession = async (
    client: ReturnType<typeof globalSDK.createClient>,
    setStore: SetStoreFunction<State>,
  ) => {
    const current = sessionID()
    if (current) {
      const existing = await client.session
        .get({ sessionID: current })
        .then((result) => result.data)
        .catch((err: unknown) => {
          if (!isSessionNotFoundError(err)) throw err
          clearSession()
          return undefined
        })
      if (existing) return existing.id
    }

    const created = await client.session.create().then((result) => result.data ?? undefined)
    if (!created) return
    seed(setStore, created)
    patchSession(setStore, created.id, { title: "Quick Assistant" })
    setSaved("session", key(), created.id)
    void client.session.update({ sessionID: created.id, title: "Quick Assistant" }).catch(() => {})
    return created.id
  }

  const open = () => {
    console.debug("[quick-assistant] panel opened")
    setSaved("open", true)
  }

  onMount(() => {
    const receive = (event: Event) => {
      const text = (event as CustomEvent<unknown>).detail
      if (!enabled() || typeof text !== "string" || !text.trim()) return
      const next = appendSelectionToPrompt(state.prompt, text)
      setState("prompt", next.prompt)
      console.debug(`[session-selection] assistant draft appended length=${text.length} cursor=${next.cursor}`)
      open()
      requestAnimationFrame(() => input?.focus())
    }
    window.addEventListener(QUICK_ASSISTANT_SELECTION_EVENT, receive)
    onCleanup(() => window.removeEventListener(QUICK_ASSISTANT_SELECTION_EVENT, receive))
  })

  const close = () => {
    console.debug("[quick-assistant] panel closed")
    setSaved("open", false)
  }

  const toggleMaximize = () => {
    const next = !saved.maximized
    console.debug(`[quick-assistant] maximize ${next ? "enabled" : "disabled"} messages=${list().length}`)
    setSaved("maximized", next)
  }

  const toggle = () => {
    if (saved.open) {
      close()
      return
    }
    open()
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
          console.error(`[quick-assistant] stop failed session=${id}`, err)
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

  const reset = async () => {
    console.debug(`[quick-assistant] reset start session=${sessionID() ?? ""} messages=${list().length}`)
    if (!(await stop())) return
    clearSession()
    setState("prompt", emptyQuickPrompt())
    console.debug("[quick-assistant] reset complete draft=0")
  }

  command.register("quick-assistant", () => [
    {
      id: "assistant.quick.toggle",
      title: language.t("command.assistant.quick.toggle"),
      description: language.t("command.assistant.quick.toggle.description"),
      keywords: `${language.t("command.assistant.quick.toggle")} ${language.t("command.assistant.quick.toggle.description")}`,
      category: language.t("command.category.session"),
      keybind: "mod+shift+j",
      disabled: !enabled(),
      onSelect: toggle,
    },
  ])

  createEffect(() => {
    if (!saved.open) return
    queueMicrotask(() => input?.focus())
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
      console.error(`[quick-assistant] stream error session=${id}`, event.properties.error)
      showToast({
        title: "Quick Assistant",
        description: formatServerError(event.properties.error, language.t, language.t("common.requestFailed")),
      })
    })

    return off
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
        console.error(`[quick-assistant] context load failed source_session=${sourceID}`, error)
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
      console.error("[quick-assistant] session setup failed", err)
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
    console.debug("[quick-assistant] request built", {
      sessionID: id,
      parts: requestParts.map((part) => part.type),
      command: custom?.name,
    })

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
      setSaved("open", true)
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
      .then(() => console.debug("[quick-assistant] request accepted", { sessionID: id, messageID }))
      .catch((err: unknown) => {
        if (!activeSend()) {
          console.debug(`[quick-assistant] stale send failure ignored session=${id} message=${messageID}`)
          return
        }
        console.error("[quick-assistant] request failed", { sessionID: id, messageID, error: err })
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

  const dock = createMemo(() => enabled() && !!activeDir())
  const bare = createMemo(() => !waiting() && list().length === 0)
  const expanded = createMemo(() => list().length > 0 && !!saved.maximized)

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
      <Show when={!saved.open && dock()}>
        <button
          type="button"
          data-component="quick-assistant-launcher"
          class="relative z-40 pointer-events-auto flex items-center gap-2 rounded-full border border-border-weak-base px-3 py-2 shadow-[var(--shadow-lg-border-base)]"
          style={{
            "background-color":
              platform.platform === "desktop" && platform.os === "windows"
                ? "var(--surface-raised-stronger-non-alpha)"
                : "color-mix(in srgb, var(--background-stronger) 92%, transparent)",
            "backdrop-filter":
              platform.platform === "desktop" && platform.os === "windows" ? "none" : "blur(24px) saturate(150%)",
            "-webkit-backdrop-filter":
              platform.platform === "desktop" && platform.os === "windows" ? "none" : "blur(24px) saturate(150%)",
          }}
          onClick={open}
        >
          <Icon name="bubble-5" class="size-4 text-icon-base" />
          <span class="text-12-medium text-text-strong">Assistant</span>
          <Show when={busy()}>
            <span class="size-2 rounded-full bg-success-base animate-pulse" />
          </Show>
        </button>
      </Show>

      <Show when={saved.open}>
        <div
          data-component="quick-assistant-panel"
          class="fixed right-5 bottom-5 z-40 pointer-events-auto max-h-[calc(100dvh-72px)] rounded-[calc(var(--radius-4xl)+0.75rem+1px)]"
          ref={(element) =>
            requestAnimationFrame(() => {
              if (!element.isConnected) return
              const composer = element.querySelector('[data-prompt-kind="quick"]')
              console.debug(
                `[quick-assistant] panel geometry radius=${getComputedStyle(element).borderRadius} composerRadius=${composer ? getComputedStyle(composer).borderRadius : "none"} contentOverflow=${getComputedStyle(element.lastElementChild!).overflow}`,
              )
            })
          }
          classList={{
            "h-[calc(100dvh-72px)]": waiting(),
            "w-[min(1040px,calc(100vw-24px))]": expanded(),
            "w-[min(520px,calc(100vw-24px))]": !expanded(),
            "border border-border-weak-base shadow-[var(--shadow-lg)]": !bare(),
          }}
          style={
            bare()
              ? undefined
              : {
                  "background-color":
                    platform.platform === "desktop" && platform.os === "windows"
                      ? "var(--surface-raised-stronger-non-alpha)"
                      : "var(--apple-dark-alpha-1)",
                  "backdrop-filter":
                    platform.platform === "desktop" && platform.os === "windows" ? "none" : "blur(40px) saturate(150%)",
                  "-webkit-backdrop-filter":
                    platform.platform === "desktop" && platform.os === "windows" ? "none" : "blur(40px) saturate(150%)",
                }
          }
        >
          <Show when={list().length > 0}>
            <button
              type="button"
              class="absolute -top-3.5 right-5 z-10 flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base/90 text-icon-weak shadow-xs-border transition hover:border-border-strong-base hover:bg-surface-base-hover hover:text-icon-base"
              aria-label={language.t(expanded() ? "common.restore" : "common.maximize")}
              title={language.t(expanded() ? "common.restore" : "common.maximize")}
              onClick={toggleMaximize}
            >
              <Icon name={expanded() ? "collapse" : "expand"} size="small" class="text-icon-weak" />
            </button>
          </Show>
          <button
            type="button"
            class="absolute -right-3.5 -top-3.5 z-10 flex size-7 items-center justify-center rounded-full border border-border-weak-base bg-background-base/90 text-icon-weak shadow-xs-border transition hover:border-border-strong-base hover:bg-surface-base-hover hover:text-icon-base"
            aria-label={language.t("common.close")}
            title={language.t("common.close")}
            onClick={close}
          >
            <Icon name="close" size="small" class="text-icon-weak" />
          </button>
          <div class="flex max-h-[calc(100dvh-72px)] flex-col rounded-[inherit]" classList={{ "h-full": waiting() }}>
            <QuickAssistantMessages list={list()} parts={data()?.part} busy={busy()} waiting={waiting()} />
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
                scope={JSON.stringify([root(), sessionID()])}
                agents={data()?.agent ?? []}
                commands={data()?.command ?? []}
                busy={interacting()}
                loading={state.loading}
                ready={!!root()}
                context={saved.context}
                contextAvailable={!!currentContext()}
                variants={variantList()}
                variant={effectiveVariant()}
                onPrompt={(next) => setState("prompt", reconcile(next))}
                onClose={close}
                onStop={() => void stop()}
                onNewSession={() => void reset()}
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
