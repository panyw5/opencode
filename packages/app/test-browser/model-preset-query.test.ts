import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { createComponent, createRoot, Suspense } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { createModelPresetQuery } from "../src/components/model-preset-query"
import type { ModelCatalog } from "../src/components/model-presets"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const data: ModelCatalog = { test: { models: { test: { family: "test" } } } }
const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)

function client() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
  cleanup.push(() => client.clear())
  return client
}

test("cold preset fetch never replaces the surrounding page with Suspense fallback", async () => {
  const queryClient = client()
  const pending = Promise.withResolvers<ModelCatalog>()
  const host = document.createElement("div")
  cleanup.push(
    render(
      () =>
        createComponent(Suspense, {
          fallback: "PAGE_FALLBACK",
          get children() {
            const catalog = createModelPresetQuery(
              () => ({ queryKey: ["cold"], queryFn: () => pending.promise }),
              queryClient,
            )
            return () => (catalog.data ? "EDITOR_READY" : "EDITOR_LOADING_PRESETS")
          },
        }),
      host,
    ),
  )
  await tick()
  expect(host.textContent).toBe("EDITOR_LOADING_PRESETS")
  pending.resolve(data)
  await tick()
  expect(host.textContent).toBe("EDITOR_READY")
})

test("multiple expanded models share one request and warm-cache reopen", async () => {
  const queryClient = client()
  const pending = Promise.withResolvers<ModelCatalog>()
  let calls = 0
  const options = () => ({
    queryKey: ["shared"],
    queryFn: () => {
      calls++
      return pending.promise
    },
  })
  const open = () =>
    createRoot((dispose) => {
      cleanup.push(dispose)
      return createModelPresetQuery(options, queryClient)
    })
  const first = open()
  const second = open()
  await tick()
  expect(calls).toBe(1)
  pending.resolve(data)
  await tick()
  expect(first.data).toEqual(data)
  expect(second.data).toEqual(data)
  const reopened = open()
  await tick()
  expect(reopened.data).toEqual(data)
  expect(calls).toBe(1)
})

test("server changes ignore stale results and clear old preset data", async () => {
  const queryClient = client()
  const old = Promise.withResolvers<ModelCatalog>()
  const next = Promise.withResolvers<ModelCatalog>()
  const state = createRoot((dispose) => {
    cleanup.push(dispose)
    const [server, setServer] = createStore({ id: "old" })
    const catalog = createModelPresetQuery(
      () => ({
        queryKey: [server.id],
        queryFn: () => (server.id === "old" ? old.promise : next.promise),
      }),
      queryClient,
    )
    return { catalog, setServer }
  })
  await tick()
  state.setServer("id", "next")
  await tick()
  expect(state.catalog.data).toBeUndefined()
  old.resolve(data)
  await tick()
  expect(state.catalog.data).toBeUndefined()
  const newer = { newer: { models: {} } }
  next.resolve(newer)
  await tick()
  expect(state.catalog.data).toEqual(newer)
})

test("errors stay local and unmounted observers ignore completion", async () => {
  const queryClient = client()
  const pending = Promise.withResolvers<ModelCatalog>()
  let dispose = () => {}
  const catalog = createRoot((stop) => {
    dispose = stop
    cleanup.push(stop)
    return createModelPresetQuery(() => ({ queryKey: ["error"], queryFn: () => pending.promise }), queryClient)
  })
  await tick()
  pending.reject(new Error("offline"))
  await tick()
  expect(catalog.isError).toBe(true)
  expect(catalog.pending).toBe(false)
  expect(catalog.data).toBeUndefined()
  dispose()
  const late = Promise.withResolvers<ModelCatalog>()
  const unmounted = createRoot((stop) => {
    dispose = stop
    cleanup.push(stop)
    return createModelPresetQuery(() => ({ queryKey: ["late"], queryFn: () => late.promise }), queryClient)
  })
  await tick()
  dispose()
  late.resolve(data)
  await tick()
  expect(unmounted.data).toBeUndefined()
})
