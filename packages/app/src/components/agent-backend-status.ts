import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import type { AgentBackendStatusResponse, OpencodeClient } from "@opencode-ai/sdk/v2/client"

const snapshots = new WeakMap<OpencodeClient, AgentBackendStatusResponse>()

/** Inspection is local to the connected backend and never clears the form. */
export function createAgentBackendStatus(client: Accessor<OpencodeClient>) {
  let owner = client()
  const [state, set] = createStore({
    latest: snapshots.get(owner),
    loading: false,
    error: "",
  })
  let generation = 0
  let controller: AbortController | undefined
  let pending: Promise<void> | undefined

  const invalidate = () => {
    generation++
    controller?.abort()
    pending = undefined
  }
  const refresh = () => {
    const target = client()
    if (owner === target && pending) return pending
    if (owner !== target) {
      invalidate()
      owner = target
      set({ latest: snapshots.get(target), error: "" })
    }
    const run = ++generation
    const operation = new AbortController()
    controller = operation
    set({ loading: true, error: "" })
    console.info(`[agent-backend.status] refresh start run=${run} cached=${!!state.latest}`)
    pending = target.agentBackend
      .status(undefined, { signal: operation.signal, throwOnError: true })
      .then((result) => {
        if (run !== generation || operation.signal.aborted || client() !== target) return
        snapshots.set(target, result.data)
        set("latest", result.data)
        console.info(`[agent-backend.status] refresh complete run=${run} adapters=${result.data.adapters.length}`)
      })
      .catch((error: unknown) => {
        if (run !== generation || operation.signal.aborted || client() !== target) return
        set("error", String(error))
        console.warn(`[agent-backend.status] refresh failed run=${run} retained=${!!state.latest}`)
      })
      .finally(() => {
        if (run !== generation) return
        pending = undefined
        set("loading", false)
      })
    return pending
  }

  let inspected: OpencodeClient | undefined
  createEffect(
    on(client, (target) => {
      if (inspected === target) return
      inspected = target
      void refresh()
    }),
  )
  onCleanup(invalidate)

  return {
    get latest() {
      return client() === owner ? state.latest : snapshots.get(client())
    },
    get loading() {
      return client() !== owner || state.loading
    },
    get error() {
      return client() === owner ? state.error : ""
    },
    refresh,
    replace(value: AgentBackendStatusResponse) {
      invalidate()
      owner = client()
      snapshots.set(owner, value)
      set({ latest: value, loading: false, error: "" })
    },
  }
}
