import { createContext, createEffect, onCleanup, useContext, type ParentProps } from "solid-js"
import { createFileTreeStore } from "./tree-store"
import { createPathHelpers } from "./path"
import { useSDK } from "../sdk"
import { useGlobalSDK } from "../global-sdk"
import { createWorkspaceTreeWatcher } from "./watcher"
import { domainFromDirectory } from "@/pages/layout/extra-agents"
import { useServer } from "@/context/server"

type Tree = ReturnType<typeof createFileTreeStore>
const Context = createContext<Tree>()

export function useWorkspaceTree() {
  const value = useContext(Context)
  if (!value) throw new Error("WorkspaceFileTreeProvider is missing")
  return value
}

export function WorkspaceFileTreeProvider(props: ParentProps<{ identity: string }>) {
  const sdk = useSDK()
  const global = useGlobalSDK()
  const server = useServer()
  const connectionIdentity = () => `${props.identity}@${server.key}`
  const scope = connectionIdentity
  let activeIdentity = connectionIdentity()
  const path = createPathHelpers(() => sdk.directory)
  const tree = createFileTreeStore({
    scope,
    normalizeDir: path.normalizeDir,
    list: (dir) => sdk.client.file.list({ path: dir }).then((x) => x.data ?? []),
    onError: (message) => console.debug(`[file-tree] list-error dir=unknown message=${message}`),
  })
  let runtimeVersion = global.forDomain(domainFromDirectory(sdk.directory)).version
  const watcher = createWorkspaceTreeWatcher({
    normalize: path.normalize,
    node: tree.node,
    isDirLoaded: tree.isLoaded,
    dirtyDir: tree.markDirty,
    dirtyAll: tree.markAllDirty,
  })
  const stop = sdk.event.listen((e) => watcher.handle(e.details))
  const currentDomain = domainFromDirectory(sdk.directory)
  const stopGlobal = global.listenAll((event) => {
    if (event.name !== "global" || event.domain !== currentDomain || event.details.type !== "server.connected") return
    console.debug(`[file-tree] server-connected scope=${scope()}`)
    tree.markAllDirty()
  })
  // Runtime changes mean a reconnect/reload for this server. Keep expanded state,
  // but force the next consumer read to validate it against the backend.
  createEffect(() => {
    const identity = connectionIdentity()
    if (identity !== activeIdentity) {
      activeIdentity = identity
      console.debug(`[file-tree] connection-change scope=${identity}`)
      tree.reset()
    }
    const next = global.forDomain(domainFromDirectory(sdk.directory)).version
    if (next === runtimeVersion) return
    runtimeVersion = next
    console.debug(`[file-tree] runtime-change version=${next} scope=${scope()}`)
    tree.markAllDirty()
  })
  onCleanup(() => {
    console.debug(`[file-tree] workspace-dispose scope=${scope()}`)
    stop()
    stopGlobal()
    watcher.dispose()
    tree.reset()
  })
  return (
    <Context.Provider value={tree}>
      {props.children}
    </Context.Provider>
  )
}
