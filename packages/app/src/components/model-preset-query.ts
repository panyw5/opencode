import type { FetchQueryOptions, QueryClient } from "@tanstack/solid-query"
import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { ModelCatalog } from "./model-presets"

export function createModelPresetQuery(
  options: () => FetchQueryOptions<ModelCatalog> | undefined,
  client: QueryClient,
) {
  const [state, setState] = createStore<{
    data: ModelCatalog | undefined
    isError: boolean
    pending: boolean
  }>({ data: undefined, isError: false, pending: false })

  createEffect(() => {
    const query = options()
    if (!query) {
      setState({ data: undefined, isError: false, pending: false })
      return
    }
    let active = true
    onCleanup(() => {
      active = false
      console.debug("[model-presets] local observer disposed", JSON.stringify(query.queryKey))
    })
    // fetchQuery retains shared caching/deduplication without a Suspense resource read.
    setState({ data: client.getQueryData<ModelCatalog>(query.queryKey), isError: false, pending: true })
    console.info("[model-presets] local load start", JSON.stringify(query.queryKey))
    void client.fetchQuery(query).then(
      (data) => {
        if (!active) {
          console.debug("[model-presets] stale result ignored", JSON.stringify(query.queryKey))
          return
        }
        setState({ data, isError: false, pending: false })
        console.info("[model-presets] local load complete", JSON.stringify(query.queryKey))
      },
      (error) => {
        if (!active) return
        setState({ data: undefined, isError: true, pending: false })
        console.error("[model-presets] local load failed", JSON.stringify(query.queryKey), String(error))
      },
    )
  })

  return state
}
