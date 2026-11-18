import type { FetchQueryOptions, QueryClient } from "@tanstack/solid-query"
import { createEffect, createRoot, createSignal } from "solid-js"
import type { ModelCatalog } from "./model-presets"

type CatalogEntry = {
  readonly data: ModelCatalog | undefined
  readonly isError: boolean
  readonly pending: boolean
  loading: boolean
  setData: (data: ModelCatalog | undefined) => void
  setMeta: (meta: { isError: boolean; pending: boolean }) => void
}

const EMPTY: Omit<CatalogEntry, "loading" | "setData" | "setMeta"> = {
  data: undefined,
  isError: false,
  pending: false,
}

// One catalog accessor per connection. Custom provider forms mount one preset
// lookup per model row, so per-row query observers multiplied the cost. The
// catalog also must not live in a store: assigning ~9k models into createStore
// made Solid deep-unwrap the whole object (~700ms per write).
const entries = new Map<string, CatalogEntry>()

function ensure(query: FetchQueryOptions<ModelCatalog>, client: QueryClient) {
  const key = JSON.stringify(query.queryKey)
  let entry = entries.get(key)
  if (!entry) {
    // Detached root: shared entries outlive any single caller's owner.
    entry = createRoot(() => {
      const [data, setData] = createSignal<ModelCatalog | undefined>(undefined)
      const [meta, setMeta] = createSignal({ isError: false, pending: false })
      return {
        loading: false,
        setData,
        setMeta,
        get data() {
          return data()
        },
        get isError() {
          return meta().isError
        },
        get pending() {
          return meta().pending
        },
      }
    })
    entries.set(key, entry)
  }
  const cached = client.getQueryData<ModelCatalog>(query.queryKey)
  if (cached !== undefined && entry.data !== cached) entry.setData(cached)
  if (entry.loading) return entry
  entry.loading = true
  if (!cached) entry.setMeta({ isError: false, pending: true })
  console.info("[model-presets] shared load start", JSON.stringify(query.queryKey))
  // fetchQuery retains shared caching/deduplication and honors staleTime.
  void client.fetchQuery(query).then(
    (data) => {
      entry.loading = false
      entry.setData(data)
      entry.setMeta({ isError: false, pending: false })
      console.info("[model-presets] shared load complete", JSON.stringify(query.queryKey))
    },
    (error) => {
      entry.loading = false
      entry.setData(undefined)
      entry.setMeta({ isError: true, pending: false })
      console.error("[model-presets] shared load failed", JSON.stringify(query.queryKey), String(error))
    },
  )
  return entry
}

export function createModelPresetQuery(
  options: () => FetchQueryOptions<ModelCatalog> | undefined,
  client: QueryClient,
) {
  const [current, setCurrent] = createSignal<Omit<CatalogEntry, "loading" | "setData" | "setMeta">>(EMPTY)

  createEffect(() => {
    const query = options()
    setCurrent(() => (query ? ensure(query, client) : EMPTY))
  })

  return {
    get data() {
      return current().data
    },
    get isError() {
      return current().isError
    },
    get pending() {
      return current().pending
    },
  }
}
