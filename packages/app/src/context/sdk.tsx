import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { type Accessor, createEffect, createMemo, onCleanup } from "solid-js"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { workspaceKey } from "@/pages/layout/helpers"
import { useGlobalSDK } from "./global-sdk"

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: Accessor<string> }) => {
    const globalSDK = useGlobalSDK()

    const directory = createMemo(props.directory)
    const domain = createMemo(() => domainFromDirectory(directory()))
    const normalizedDirectory = createMemo(() => directory().replace(/\\/g, "/"))
    const client = createMemo(() =>
      globalSDK.forDomain(domainFromDirectory(normalizedDirectory())).createClient({
        directory: normalizedDirectory(),
        throwOnError: true,
      }),
    )

    const emitter = createGlobalEmitter<SDKEventMap>()

    createEffect(() => {
      const dir = directory()
      const key = workspaceKey(dir)
      const forward = (event: { type: string }) => {
        if (event.type === "sync") return
        // EventMap is generated from the public Event union; cast at the boundary.
        emitter.emit(event.type as keyof SDKEventMap, event as never)
      }
      // Exact key subscription (normal path).
      const unsubExact = globalSDK.eventFor(domainFromDirectory(dir)).on(dir, forward)
      // Alias path: server may emit realpath while the app is keyed by route/worktree.
      const unsubAlias = globalSDK.listenAll((e) => {
        if (e.name === dir) return
        if (workspaceKey(e.name) !== key) return
        forward(e.details)
      })
      onCleanup(() => {
        unsubExact()
        unsubAlias()
      })
    })

    return {
      get directory() {
        return directory()
      },
      get client() {
        return client()
      },
      event: emitter,
      get url() {
        return globalSDK.forDomain(domain()).url
      },
      createClient(opts: Parameters<typeof globalSDK.createClient>[0]) {
        return globalSDK.forDomain(domain()).createClient(opts)
      },
    }
  },
})
