import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { modelEnabled, modelProbe } from "@/testing/model-selection"
import { Persist, persisted } from "@/utils/persist"
import { createSessionModelRestoreQueue } from "@/pages/session/session-model-helpers"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { internalAgent, primaryAgents, selectableAgents } from "./agent-selection"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServer } from "./server"
import { usePlatform } from "./platform"
import { workspacePathContext } from "@/pages/layout/helpers"

export type ModelKey = { providerID: string; modelID: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

type RestoreMessage = {
  sessionID: string
  agent: string
  model: ModelKey & { variant?: string }
}

type Saved = {
  session: Record<string, State | undefined>
}

const WORKSPACE_KEY = "__workspace__"
const handoff = new Map<string, State>()
const manualSession = new Map<string, State>()

function modelDebug(event: string, details: Record<string, unknown>) {
  if (!import.meta.env.DEV) return
  console.debug(`[local:model] ${event} ${JSON.stringify(details)}`)
}

const handoffKey = (dir: string, id: string) => `${dir}\n${id}`

const migrate = (value: unknown) => {
  if (!value || typeof value !== "object") return { session: {} }

  const item = value as {
    session?: Record<string, State | undefined>
    pick?: Record<string, State | undefined>
  }

  if (item.session && typeof item.session === "object") return { session: item.session }
  if (!item.pick || typeof item.pick !== "object") return { session: {} }

  return {
    session: Object.fromEntries(Object.entries(item.pick).filter(([key]) => key !== WORKSPACE_KEY)),
  }
}

const clone = (value: State | undefined) => {
  if (!value) return undefined
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useSDK()
    const server = useServer()
    const platform = usePlatform()
    const sync = useSync()
    const providers = useProviders()
    const models = useModels()
    const pathContext = workspacePathContext({ os: platform.os, isLocal: !!server.isLocal(), directory: sdk.directory })

    const id = createMemo(() => params.id || undefined)
    const available = createMemo(() => primaryAgents(sync.data.agent))
    const list = createMemo(() => selectableAgents(sync.data.agent))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved, , savedReady] = persisted(
      {
        ...Persist.workspace(sdk.directory, "model-selection", ["model-selection.v1"], pathContext),
        migrate,
      },
      createStore<Saved>({
        session: {},
      }),
    )

    createEffect(() => {
      if (!savedReady()) return
      modelDebug("persistence-ready", { directory: sdk.directory, sessionID: id() ?? "none" })
    })

    const [store, setStore] = createStore<{
      current?: string
      locked?: string
      draft?: State
      promoting?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    const validModel = (model: ModelKey) => {
      const provider = providers.all().find((item) => item.id === model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const firstModel = (...items: Array<() => ModelKey | undefined>) => {
      for (const item of items) {
        const model = item()
        if (!model) continue
        if (validModel(model)) return model
      }
    }

    const pickAgent = (name: string | undefined) => {
      const items = list()
      if (items.length === 0) return undefined
      return items.find((item) => item.name === name) ?? items[0]
    }

    const pickInternalAgent = (name: string | undefined) => internalAgent(available(), name)

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? store.promoting
      const key = handoffKey(sdk.directory, session)
      return manualSession.get(key) ?? saved.session[session] ?? handoff.get(key)
    })

    // Track previous session to preserve model selection when switching
    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(sdk.directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        setStore("promoting", undefined)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
      setStore("promoting", undefined)
    })

    // Preserve model selection when switching to a session without saved state
    createEffect(
      (prevSession: string | undefined) => {
        const session = id()

        // If switching from one session to another
        if (prevSession && session && prevSession !== session) {
          modelDebug("session-switch", {
            fromSessionID: prevSession,
            toSessionID: session,
            fromSaved:
              manualSession.has(handoffKey(sdk.directory, prevSession)) || saved.session[prevSession] !== undefined,
            toSaved: manualSession.has(handoffKey(sdk.directory, session)) || saved.session[session] !== undefined,
            handoff: handoff.has(handoffKey(sdk.directory, session)),
          })
          // If the new session doesn't have saved state, inherit from previous session
          const targetKey = handoffKey(sdk.directory, session)
          if (!manualSession.has(targetKey) && saved.session[session] === undefined && !handoff.has(targetKey)) {
            const prevState = manualSession.get(handoffKey(sdk.directory, prevSession)) ?? saved.session[prevSession]
            if (prevState) {
              modelDebug("session-inherit-applied", {
                fromSessionID: prevSession,
                toSessionID: session,
                model: prevState.model ? `${prevState.model.providerID}/${prevState.model.modelID}` : "none",
              })
              const next = clone(prevState)
              if (next) {
                manualSession.set(targetKey, next)
                setSaved("session", session, next)
              }
            }
          }
        }

        return session
      },
      undefined as string | undefined,
    )

    const configuredModel = () => {
      if (!sync.data.config.model) return
      const [providerID, modelID] = sync.data.config.model.split("/")
      const model = { providerID, modelID }
      if (validModel(model)) return model
    }

    const recentModel = () => {
      for (const item of models.recent.list()) {
        if (validModel(item)) return item
      }
    }

    const defaultModel = () => {
      const defaults = providers.default()
      for (const provider of providers.connected()) {
        const configured = defaults[provider.id]
        if (configured) {
          const model = { providerID: provider.id, modelID: configured }
          if (validModel(model)) return model
        }

        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const fallback = createMemo<ModelKey | undefined>(() => configuredModel() ?? recentModel() ?? defaultModel())

    const agent = {
      list,
      available(name: string) {
        return !!pickInternalAgent(name)
      },
      locked() {
        if (!store.locked) return undefined
        return pickInternalAgent(store.locked)
      },
      current() {
        if (store.locked) return pickInternalAgent(store.locked)
        return pickAgent(scope()?.agent ?? store.current)
      },
      set(name: string | undefined) {
        const item = store.locked ? pickInternalAgent(store.locked) : pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const prev = scope()
          const next = {
            agent: item.name,
            model: item.model ?? prev?.model,
            variant: item.variant ?? prev?.variant,
          } satisfies State
          const session = id()
          if (session) {
            const key = handoffKey(sdk.directory, session)
            manualSession.set(key, clone(next) ?? next)
            modelDebug("manual-agent-write", {
              sessionID: session,
              model: next.model ? `${next.model.providerID}/${next.model.modelID}` : "none",
              ready: savedReady(),
            })
            setSaved("session", session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        if (store.locked) return
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
      lock(name: string | undefined) {
        const item = pickInternalAgent(name)
        if (name && !item) return false
        setStore("locked", item?.name)
        if (item) agent.set(item.name)
        return true
      },
    }

    const current = () => {
      const session = id()
      const item = firstModel(
        () => scope()?.model,
        // Existing sessions must wait for their saved/message model. Configured
        // and agent defaults are only valid for drafts and newly created sessions.
        () => (session ? undefined : agent.current()?.model),
        () => (session ? undefined : fallback()),
      )
      if (!item) return undefined
      return models.find(item)
    }

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return undefined
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const selected = () => scope()?.variant

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        const key = handoffKey(sdk.directory, session)
        const manual = clone(state)
        if (manual) manualSession.set(key, manual)
        modelDebug("manual-write", {
          sessionID: session,
          model: state.model ? `${state.model.providerID}/${state.model.modelID}` : "none",
          ready: savedReady(),
        })
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        batch(() => {
          setStore("last", {
            type: "model",
            agent: agent.current()?.name,
            model: item ?? null,
            variant: selected(),
          })
          write({ model: item })
          if (!item) return
          models.setVisibility(item, true)
          if (!options?.recent) return
          models.recent.push(item)
        })
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          return resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          batch(() => {
            const model = current()
            setStore("last", {
              type: "variant",
              agent: agent.current()?.name,
              model: model ? { providerID: model.provider.id, modelID: model.id } : null,
              variant: value ?? null,
            })
            write({ variant: value ?? null })
          })
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    // Do not let message history write over a session selection before async desktop storage is loaded.
    const applyRestore = (msg: RestoreMessage) => {
      const session = id()
      if (!session) {
        modelDebug("restore-skipped", { reason: "no-session", messageSessionID: msg.sessionID })
        return
      }
      if (msg.sessionID !== session) {
        modelDebug("restore-skipped", {
          reason: "session-mismatch",
          sessionID: session,
          messageSessionID: msg.sessionID,
        })
        return
      }
      if (saved.session[session] !== undefined) {
        modelDebug("restore-skipped", { reason: "saved-state-exists", sessionID: session })
        return
      }
      if (manualSession.has(handoffKey(sdk.directory, session))) {
        modelDebug("restore-skipped", { reason: "manual-memory-exists", sessionID: session })
        return
      }
      if (handoff.has(handoffKey(sdk.directory, session))) {
        modelDebug("restore-skipped", { reason: "handoff-exists", sessionID: session })
        return
      }

      modelDebug("restore-applied", {
        sessionID: session,
        agent: msg.agent,
        model: `${msg.model.providerID}/${msg.model.modelID}`,
      })
      setSaved("session", session, {
        agent: msg.agent,
        model: msg.model,
        variant: msg.model.variant ?? null,
      })
    }

    const requestRestore = createSessionModelRestoreQueue({
      ready: savedReady,
      wait: savedReady.promise,
      restore: applyRestore,
    })

    const result = {
      slug: createMemo(() => base64Encode(sdk.directory)),
      model,
      agent,
      session: {
        reset() {
          setStore({ draft: undefined, promoting: undefined })
        },
        promote(dir: string, session: string) {
          const next = clone(snapshot())
          if (!next) return
          const key = handoffKey(dir, session)
          handoff.set(key, next)

          if (dir === sdk.directory) {
            manualSession.set(key, next)
            setSaved("session", session, next)
          }

          setStore("promoting", next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey; variant?: string }) {
          modelDebug("restore-requested", {
            sessionID: msg.sessionID,
            model: `${msg.model.providerID}/${msg.model.modelID}`,
            ready: savedReady(),
          })
          requestRestore(msg)
        },
      },
    }

    if (modelEnabled()) {
      createEffect(() => {
        const agent = result.agent.current()
        const model = result.model.current()
        modelProbe.set({
          dir: sdk.directory,
          sessionID: id(),
          last: store.last,
          agent: agent?.name,
          model: model
            ? {
                providerID: model.provider.id,
                modelID: model.id,
                name: model.name,
              }
            : undefined,
          variant: result.model.variant.current() ?? null,
          selected: result.model.variant.selected(),
          configured: result.model.variant.configured(),
          pick: scope(),
          base: undefined,
          current: store.current,
        })
      })

      onCleanup(() => modelProbe.clear())
    }

    return result
  },
})
