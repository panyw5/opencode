import { useLocation } from "@solidjs/router"
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  getOwner,
  onCleanup,
  onMount,
  Show,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { registerFileViewer } from "@opencode-ai/ui/file-viewer-registry"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"
import { createExtensionApi } from "./api"
import { addExtensionStyle, ExtensionActivationManager, importExtensionModule } from "./activation"
import { declaredViewer, extensionViewerID, type FileViewerContribution } from "./context"
import { installExtensionHostModules } from "./modules"
import { safeModeFromURL } from "./safe-mode"
import type { ExtensionInfo, ExtensionStatusEvent } from "./types"

export type ExtensionHost = {
  activate(id: string): Promise<void>
  refresh(): Promise<void>
  enabled(): boolean
}

const ExtensionHostContext = createContext<ExtensionHost>()

function LoadingViewer(props: { activate: () => Promise<void>; failed: () => boolean; retry: () => void }) {
  onMount(() => {
    if (!props.failed()) void props.activate()
  })
  return (
    <div class="flex min-h-32 items-center justify-center gap-3 text-text-weak">
      <Show when={props.failed()} fallback={<Spinner class="size-4" />}>
        <button type="button" class="text-text-strong underline" onClick={props.retry}>
          Retry extension
        </button>
      </Show>
    </div>
  )
}

export function ExtensionHostProvider(props: ParentProps) {
  const owner = getOwner()
  if (!owner) throw new Error("ExtensionHost requires a Solid owner")
  const globalSDK = useGlobalSDK()
  const platform = usePlatform()
  const location = useLocation()
  const api = createExtensionApi({ globalSDK })
  const [safe, setSafe, , safeReady] = persisted(
    Persist.global("extension.safeMode.v1"),
    createStore({ disabled: false }),
  )
  const mode = createMemo(() => safeModeFromURL(location.search, safe.disabled))
  const [manifests, setManifests] = createSignal<ExtensionInfo[]>([])
  const [failures, setFailures] = createSignal<ReadonlySet<string>>(new Set())
  const placeholders = new Map<string, Array<() => void>>()

  createEffect(() => {
    if (!safeReady() || !mode().persist || safe.disabled === mode().disabled) return
    setSafe("disabled", mode().disabled)
  })

  installExtensionHostModules(platform.version)

  const manager = new ExtensionActivationManager({
    hostOwner: owner,
    importModule: importExtensionModule,
    addStyle: addExtensionStyle,
    registerViewer(manifest, contribution) {
      const declared = declaredViewer(manifest, contribution.id)
      if (!declared) throw new Error(`Extension registered undeclared file viewer: ${contribution.id}`)
      return registerFileViewer({
        id: extensionViewerID(manifest.id, contribution.id),
        owner: manifest.id,
        title: declared.title,
        mode: declared.mode ?? "replace",
        priority: typeof declared.priority === "number" ? declared.priority : undefined,
        extensions: declared.extensions,
        filenames: declared.filenames,
        mime: declared.mime,
        component: contribution.component,
      })
    },
  })

  const manifest = (id: string) => manifests().find((item) => item.id === id)
  const activate = async (id: string) => {
    const item = manifest(id)
    if (!item || !item.enabled || item.state !== "ready" || mode().disabled) return
    await manager.activate(item).then(
      () => setFailures((current) => new Set([...current].filter((value) => value !== id))),
      (error) => {
        setFailures((current) => new Set(current).add(id))
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[extension-host] activate failed id=${id} error=${message}`)
        showToast({ variant: "error", title: item.displayName, description: message })
      },
    )
  }

  const clearPlaceholders = (id: string) => {
    for (const dispose of placeholders.get(id) ?? []) dispose()
    placeholders.delete(id)
  }

  const registerPlaceholders = (item: ExtensionInfo) => {
    if (manager.active(item.id)) return
    clearPlaceholders(item.id)
    if (!item.enabled || item.state !== "ready" || mode().disabled) return
    const disposers = (item.contributes.fileViewers ?? []).map((viewer) =>
      registerFileViewer({
        id: extensionViewerID(item.id, viewer.id),
        owner: item.id,
        title: viewer.title,
        mode: viewer.mode ?? "replace",
        priority: typeof viewer.priority === "number" ? viewer.priority : undefined,
        extensions: viewer.extensions,
        filenames: viewer.filenames,
        mime: viewer.mime,
        component: () => (
          <LoadingViewer
            activate={() => activate(item.id)}
            failed={() => failures().has(item.id)}
            retry={() => {
              setFailures((current) => new Set([...current].filter((value) => value !== item.id)))
              void activate(item.id)
            }}
          />
        ),
      }),
    )
    placeholders.set(item.id, disposers)
  }

  const reconcile = async (next: ExtensionInfo[]) => {
    const previous = new Map(manifests().map((item) => [item.id, item]))
    const incoming = new Map(next.map((item) => [item.id, item]))
    for (const [id, item] of previous) {
      const fresh = incoming.get(id)
      const changed =
        !fresh ||
        !fresh.enabled ||
        fresh.state !== "ready" ||
        fresh.version !== item.version ||
        fresh.web?.base !== item.web?.base ||
        fresh.web?.entry !== item.web?.entry
      if (!changed) continue
      await manager.deactivate(id)
      clearPlaceholders(id)
    }
    setManifests(next)
    for (const item of next) registerPlaceholders(item)
    await Promise.all(next.filter((item) => item.activation.includes("onStartup")).map((item) => activate(item.id)))
  }

  let activeServerURL = globalSDK.url
  const refresh = async () => {
    const serverURL = globalSDK.url
    if (activeServerURL !== serverURL) {
      activeServerURL = serverURL
      await manager.disposeAll()
      for (const id of placeholders.keys()) clearPlaceholders(id)
      setManifests([])
      setFailures(new Set<string>())
    }
    if (mode().disabled) {
      await reconcile([])
      return
    }
    await api.list().then(reconcile).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[extension-host] manifest refresh failed error=${message}`)
    })
  }

  createEffect(() => {
    if (!safeReady()) return
    globalSDK.url
    mode().disabled
    void refresh()
  })
  const stop = globalSDK.listenAll((event) => {
    const payload = event.details as unknown as ExtensionStatusEvent
    if (payload.type !== "extension.status") return
    if (payload.properties.state === "disabled") {
      void manager
        .deactivate(payload.properties.id)
        .then(() => {
          setFailures((current) => new Set([...current].filter((value) => value !== payload.properties.id)))
          clearPlaceholders(payload.properties.id)
          return refresh()
        })
        .catch((error) => {
          console.warn(
            `[extension-host] disable cleanup failed id=${payload.properties.id} error=${error instanceof Error ? error.message : String(error)}`,
          )
        })
      return
    }
    void refresh()
  })

  onCleanup(() => {
    stop()
    for (const id of placeholders.keys()) clearPlaceholders(id)
    void manager.disposeAll().catch((error) => {
      console.warn(`[extension-host] dispose failed error=${error instanceof Error ? error.message : String(error)}`)
    })
  })

  const value: ExtensionHost = { activate, refresh, enabled: () => !mode().disabled }
  return <ExtensionHostContext.Provider value={value}>{props.children}</ExtensionHostContext.Provider>
}

export function useExtensionHost() {
  const value = useContext(ExtensionHostContext)
  if (!value) throw new Error("useExtensionHost must be used within ExtensionHostProvider")
  return value
}
