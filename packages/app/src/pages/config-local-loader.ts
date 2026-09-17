import { createEffect, on, onCleanup, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"

type LocalLoaderState<T> = {
  latest: T | undefined
  loading: boolean
  error: unknown
}

export function createConfigLocalLoader<S, T>(
  source: Accessor<S | false | null | undefined>,
  fetcher: (source: S) => Promise<T>,
  name: string,
) {
  const [state, setState] = createStore<LocalLoaderState<T>>({
    latest: undefined,
    loading: false,
    error: undefined,
  })
  let version = 0

  createEffect(
    on(
      source,
      (value) => {
        const run = ++version
        if (value === false || value === null || value === undefined) {
          setState({ loading: false, error: undefined })
          return
        }

        const started = performance.now()
        setState({ loading: true, error: undefined })
        console.info(`[config-local-loader] start name=${name} run=${String(run)}`)
        void Promise.resolve()
          .then(() => fetcher(value))
          .then((result) => {
            if (run !== version) return
            setState("latest", () => result)
            console.info(
              `[config-local-loader] complete name=${name} run=${String(run)} ms=${(performance.now() - started).toFixed(1)}`,
            )
          })
          .catch((error: unknown) => {
            if (run !== version) return
            setState("error", error)
            console.error(`[config-local-loader] failed name=${name} run=${String(run)}`, error)
          })
          .finally(() => {
            if (run !== version) return
            setState("loading", false)
          })
      },
      { defer: false },
    ),
  )

  onCleanup(() => {
    version++
  })

  return {
    get latest() {
      return state.latest
    },
    get loading() {
      return state.loading
    },
    get error() {
      return state.error
    },
    replace(value: T) {
      setState("latest", () => value)
      setState("error", undefined)
    },
  }
}
