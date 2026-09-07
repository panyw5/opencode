import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { type Accessor, createEffect, createMemo, onCleanup } from "solid-js"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { workspaceKey, workspacePathContext } from "@/pages/layout/helpers"
import { Path } from "@opencode-ai/core/util/path"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform } from "./platform"
import { useServer } from "./server"

type SDKEventMap = {
  [key in Event["type"]]: Extract<Event, { type: key }>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: { directory: Accessor<string> }) => {
    const globalSDK = useGlobalSDK()
    const platform = usePlatform()
    const server = useServer()

    const directory = createMemo(props.directory)
    const pathContext = createMemo(() =>
      workspacePathContext({ os: platform.os, isLocal: !!server.isLocal(), directory: directory() }),
    )
    const domain = createMemo(() => domainFromDirectory(directory()))
    const normalizedDirectory = createMemo(() => String(Path.logical(directory(), pathContext())))
    const client = createMemo(() =>
      globalSDK.forDomain(domainFromDirectory(normalizedDirectory())).createClient({
        directory: normalizedDirectory(),
        throwOnError: true,
      }),
    )

    const emitter = createGlobalEmitter<SDKEventMap>()

    createEffect(() => {
      const dir = directory()
      const context = pathContext()
      const key = workspaceKey(dir, context)
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
        if (workspaceKey(e.name, context) !== key) return
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
      get pathContext() {
        return pathContext()
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
