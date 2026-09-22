import { createSimpleContext } from "@opencode-ai/ui/context"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { modelEnabled, modelProbe } from "@/testing/model-selection"
import { Persist, persisted } from "@/utils/persist"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./model-variant"
import { internalAgent, primaryAgents, selectableAgents } from "./agent-selection"
import {
  activeSelection,
  restoreMessageSelection,
  selectAgent,
  selectModel,
  selectVariant,
  type ModelKey,
  type ModelSelection,
} from "./model-selection-state"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useServer } from "./server"
import { usePlatform } from "./platform"
import { workspacePathContext } from "@/pages/layout/helpers"

export type { ModelKey } from "./model-selection-state"

type State = ModelSelection

type RestoreMessage = {
  sessionID: string
  agent: string
  model: ModelKey & { variant?: string }
}

type Saved = {
  session: Record<string, State | undefined>
}

const handoff = new Map<string, State>()

function modelDebug(event: string, details: Record<string, unknown>) {
  if (!import.meta.env.DEV) return
  console.debug(`[local:model] ${event} ${JSON.stringify(details)}`)
}

const handoffKey = (dir: string, id: string) => `${dir}\n${id}`

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
      Persist.workspace(sdk.directory, "model-selection.v2", undefined, pathContext),
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
      restored: Record<string, State | undefined>
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      restored: {},
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
      return activeSelection({
        sessionID: session,
        manual: session ? saved.session[session] : undefined,
        restored: session ? (store.restored[session] ?? handoff.get(handoffKey(sdk.directory, session))) : undefined,
        draft: store.draft,
        promoting: store.promoting,
      })
    })

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

    const save = (state: State) => {
      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

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
        const current = scope() ?? { agent: agent.current()?.name }
        const next = selectAgent(current, item)
        if (next === current) return
        modelDebug("agent-selected", {
          sessionID: id() ?? "draft",
          agent: item.name,
          model: next.model ? `${next.model.providerID}/${next.model.modelID}` : "none",
        })

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          save(next)
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
          modelDebug("model-selected", {
            sessionID: id() ?? "draft",
            model: item ? `${item.providerID}/${item.modelID}` : "none",
          })
          save(selectModel(scope() ?? { agent: agent.current()?.name }, item))
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
            save(selectVariant(scope() ?? { agent: agent.current()?.name }, value ?? null))
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

    const restore = (msg: RestoreMessage) => {
      const session = id()
      if (!session || msg.sessionID !== session) return
      const key = handoffKey(sdk.directory, session)
      const next = restoreMessageSelection({
        manual: saved.session[session],
        handoff: handoff.get(key),
        message: {
          agent: msg.agent,
          model: msg.model,
          variant: msg.model.variant ?? null,
        },
      })
      if (next) {
        modelDebug("message-restored", {
          sessionID: session,
          model: `${msg.model.providerID}/${msg.model.modelID}`,
        })
        setStore("restored", session, next)
      }
    }

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
            setSaved("session", session, next)
          }

          setStore("promoting", next)
          setStore("draft", undefined)
        },
        restore(msg: { sessionID: string; agent: string; model: ModelKey; variant?: string }) {
          restore(msg)
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
