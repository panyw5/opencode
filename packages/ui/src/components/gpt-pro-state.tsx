import { createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { GptProAPI } from "@opencode-ai/util/gpt-pro"
import {
  createGptProStateStore,
  type GptProStateClient,
  type GptProStateEntry,
  type GptProStateStore,
} from "@opencode-ai/util/gpt-pro-store"

const stores = new WeakMap<GptProStateClient, GptProStateStore>()

export function gptProStateStore(client: GptProStateClient) {
  let store = stores.get(client)
  if (!store) {
    store = createGptProStateStore(client, (message) => console.debug(message))
    stores.set(client, store)
  }
  return store
}

export function useGptProConsultation(client: () => GptProAPI | undefined, id: () => string | undefined) {
  const initialClient = client()
  const initialID = id()
  const [state, set] = createStore<{ entry: GptProStateEntry }>({
    entry: initialClient && initialID ? gptProStateStore(initialClient).get(initialID) : { freshness: "unavailable" },
  })
  createEffect(() => {
    const api = client()
    const jobID = id()
    if (!api || !jobID) {
      set("entry", { freshness: "unavailable", state: undefined, error: undefined })
      return
    }
    const store = gptProStateStore(api)
    const unsubscribe = store.watch(jobID, () => set("entry", reconcile(store.get(jobID), { merge: false })))
    onCleanup(unsubscribe)
  })
  return () => state.entry
}
