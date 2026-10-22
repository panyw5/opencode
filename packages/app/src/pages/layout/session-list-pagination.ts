import { createEffect, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

export function createSessionListPagination(scope: Accessor<string>, initial = 10, step = 5) {
  // The sidebar instance survives project switches; its limits must not follow it.
  const [limits, setLimits] = createStore<Record<string, number>>({})
  const limit = () => limits[scope()] ?? initial

  createEffect(() => {
    console.debug(`[sidebar-project] pagination active scope=${scope()} limit=${limit()}`)
  })

  const loadMore = async () => {
    const key = scope()
    const before = limit()
    const next = before + step
    console.debug(`[sidebar-project] pagination load-more start scope=${key} before=${before} next=${next}`)
    setLimits(key, next)
    console.debug(`[sidebar-project] pagination load-more done scope=${key} limit=${limit()}`)
  }

  return { limit, loadMore }
}
