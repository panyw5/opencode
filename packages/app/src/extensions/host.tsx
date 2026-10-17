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
  type Component,
  type ParentProps,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { createStore } from "solid-js/store"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { registerFileViewer } from "@opencode-ai/ui/file-viewer-registry"
import { GenericTool } from "@opencode-ai/ui/basic-tool"
import { isBuiltinToolRenderer, registerTool, type ToolProps } from "@opencode-ai/ui/message-part"
import { useCommand, type CommandOption } from "@/context/command"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"
import { registerToolHeightEstimator } from "@/pages/session/timeline/tool-height"
import { Persist, persisted } from "@/utils/persist"
import { createExtensionApi, createExtensionBridge, listenExtensionEvents } from "./api"
import {
  createInstallationApi,
  synchronizeInstallation,
  type InstallationRequest,
  type PreparedInstallation,
  type InstallationResult,
  type InstallationStatus,
} from "./install-api"
import { addExtensionStyle, ExtensionActivationManager, importExtensionModule } from "./activation"
import { extensionDefinition } from "./definition"
import {
  declaredCommand,
  declaredPanel,
  declaredToolRenderer,
  declaredViewer,
  extensionCommandID,
  extensionViewerID,
  type FileViewerContribution,
} from "./context"
import { installExtensionHostModules } from "./modules"
import { extensionScopedMount } from "./mount"
import { createExtensionMutationTracker, ExtensionMutationStaleError } from "./mutation"
import { reconcileExtensions } from "./reconcile"
import { registerExtensionPanel, type ExtensionPanelProps } from "./panel-registry"
import { safeModeFromURL } from "./safe-mode"
import type { CommandDeclaration, ExtensionInfo, ExtensionStatusEvent, PanelDeclaration } from "./types"

// Re-exported so UI callers can catch stale toggle/settings responses from the
// same module they get the host from.
export { ExtensionMutationStaleError } from "./mutation"

export type ExtensionHost = {
  activate(id: string): Promise<void>
  refresh(options?: { strict?: boolean }): Promise<void>
  enabled(): boolean
  extensions(): ExtensionInfo[]
  updateSettings(id: string, patch: Record<string, unknown>): Promise<ExtensionInfo>
  // Toggles the persisted enabled flag and reconciles the host with the
  // response. `synced` is false when the follow-up strict re-read failed: the
  // toggle itself still happened (and stays applied), but host state may not
  // fully reflect the server yet.
  setEnabled(id: string, enabled: boolean): Promise<{ info: ExtensionInfo; synced: boolean }>
  // Reactive busy flag for state-changing operations (enable/disable and
  // settings updates) on the extension, so the UI can block re-entry.
  mutating(id: string): boolean
  prepareInstallation(request: InstallationRequest): Promise<PreparedInstallation>
  commitInstallation(prepared: PreparedInstallation, input?: { enable?: boolean }): Promise<InstallationResult>
  installationStatus(prepared: PreparedInstallation): Promise<InstallationStatus>
  cancelInstallation(prepared: PreparedInstallation): Promise<InstallationResult>
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
  const server = useServer()
  const location = useLocation()
  const api = createExtensionApi({ globalSDK })
  const installationApi = createInstallationApi(globalSDK)
  // Authenticated transport for the extension server bridge (P2). Credentials
  // come from the current server connection, matching how the SDK client and
  // the raw file fetch authorize; platform.fetch keeps Desktop proxying intact.
  const bridge = createExtensionBridge({
    serverURL: () => globalSDK.url,
    headers(): Record<string, string> {
      const connection = server.current
      if (!connection?.http.password) return {}
      const headers: Record<string, string> = {}
      headers.authorization = `Basic ${authTokenFromCredentials({
        username: connection.http.username,
        password: connection.http.password,
      })}`
      return headers
    },
    fetch: platform.fetch ?? fetch,
  })
  const command = useCommand()
  const [safe, setSafe, , safeReady] = persisted(
    Persist.global("extension.safeMode.v1"),
    createStore({ disabled: false }),
  )
  const mode = createMemo(() => safeModeFromURL(location.search, safe.disabled))
  const [manifests, setManifests] = createSignal<ExtensionInfo[]>([])
  const [failures, setFailures] = createSignal<ReadonlySet<string>>(new Set())
  const placeholders = new Map<string, Array<() => void>>()
  // Definition string each extension's placeholders were last registered from.
  // Reconcile compares it against the fresh manifest so unchanged extensions
  // keep their registrations instead of being torn down on every refresh.
  const registered = new Map<string, string>()
  // Once the provider unmounts, nothing may mutate host state again: neither
  // an in-flight refresh/reconcile pass nor a status event settling late.
  let disposed = false

  // Live command options contributed by activated extensions, keyed by the
  // global command id (`ext.<extensionID>.<id>`). Placeholder options from the
  // manifest are replaced by the real ones on activation and restored on
  // deactivation, mirroring registerTool's restore-previous semantics.
  const [commandOptions, setCommandOptions] = createSignal<ReadonlyMap<string, CommandOption>>(new Map())
  const putCommandOption = (id: string, option: CommandOption) => {
    const previous = commandOptions().get(id)
    setCommandOptions((current) => new Map(current).set(id, option))
    return () => {
      if (commandOptions().get(id) !== option) return
      setCommandOptions((current) => {
        const next = new Map(current)
        if (previous) next.set(id, previous)
        else next.delete(id)
        return next
      })
    }
  }
  command.register("extensions", () => [...commandOptions().values()])

  // Real panel components registered by activated extensions. The manifest
  // placeholder entry stays in the panel registry (it provides the declared
  // title/icon and renders the real component once available), so replacement
  // never churns the registry or rewrites open tabs.
  const [realPanels, setRealPanels] = createSignal<ReadonlyMap<string, Component<ExtensionPanelProps>>>(new Map())
  const putRealPanel = (key: string, component: Component<ExtensionPanelProps>) => {
    const previous = realPanels().get(key)
    setRealPanels((current) => new Map(current).set(key, component))
    return () => {
      if (realPanels().get(key) !== component) return
      setRealPanels((current) => {
        const next = new Map(current)
        if (previous) next.set(key, previous)
        else next.delete(key)
        return next
      })
    }
  }

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
    registerToolRenderer(manifest, contribution) {
      const declared = declaredToolRenderer(manifest, contribution.tool)
      if (!declared) throw new Error(`Extension registered undeclared tool renderer: ${contribution.tool}`)
      if (isBuiltinToolRenderer(contribution.tool)) {
        throw new Error(`Extension cannot override built-in tool renderer: ${contribution.tool}`)
      }
      const disposeRenderer = registerTool({
        name: contribution.tool,
        render: extensionScopedMount(manifest.id, contribution.component),
      })
      const disposeEstimator = contribution.estimateHeight
        ? registerToolHeightEstimator(contribution.tool, contribution.estimateHeight)
        : undefined
      return () => {
        disposeRenderer()
        disposeEstimator?.()
      }
    },
    registerPanel(manifest, contribution) {
      const declared = declaredPanel(manifest, contribution.id)
      if (!declared) throw new Error(`Extension registered undeclared panel: ${contribution.id}`)
      return putRealPanel(`${manifest.id}/${contribution.id}`, contribution.component)
    },
    registerCommand(manifest, contribution) {
      const declared = declaredCommand(manifest, contribution.id)
      if (!declared) throw new Error(`Extension registered undeclared command: ${contribution.id}`)
      const id = extensionCommandID(manifest.id, contribution.id)
      return putCommandOption(id, {
        id,
        title: declared.title,
        category: declared.category,
        keybind: declared.keybind,
        slash: declared.slash,
        onSelect: (source) => contribution.run(source),
      })
    },
    callRpc(manifest, input) {
      return bridge.rpc({
        extensionID: manifest.id,
        method: input.method,
        input: input.input,
        options: {
          directory: input.directory,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        },
      })
    },
    listenEvents(manifest, name, listener) {
      return listenExtensionEvents({
        extensionID: manifest.id,
        name,
        listener,
        source: {
          get url() {
            return globalSDK.url
          },
          listenAll(cb) {
            return globalSDK.listenAll((event) => cb(event))
          },
          forDomain(domain) {
            return globalSDK.forDomain(domain as Parameters<typeof globalSDK.forDomain>[0])
          },
        },
      })
    },
    readSetting(extension, key) {
      return manifest(extension.id)?.settings?.[key]
    },
    async updateSettings(extension, patch) {
      const serverURL = globalSDK.url
      const connection = globalSDK.client
      const settings = await bridge.updateSettings({ extensionID: extension.id, patch })
      // The PATCH response is the authoritative masked snapshot for this
      // extension; apply it locally without a full manifest refetch. A late
      // response from a server the host no longer tracks is dropped instead
      // of being applied to the current server's state.
      if (disposed || globalSDK.url !== serverURL || globalSDK.client !== connection) return
      setManifests((current) => current.map((item) => (item.id === extension.id ? { ...item, settings } : item)))
    },
  })

  const manifest = (id: string) => manifests().find((item) => item.id === id)
  const clearFailure = (id: string) => {
    setFailures((current) => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }
  const activate = async (id: string) => {
    const item = manifest(id)
    if (!item || !item.enabled || item.state !== "ready" || mode().disabled) return
    // Server-only extensions have nothing to load in the UI.
    if (!item.web?.entry) return
    await manager.activate(item).then(
      () => clearFailure(id),
      (error) => {
        setFailures((current) => new Set(current).add(id))
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[extension-host] activate failed id=${id} error=${message}`)
        showToast({ variant: "error", title: item.displayName, description: message })
      },
    )
  }

  const retryActivation = (id: string) => {
    clearFailure(id)
    void activate(id)
  }

  const clearPlaceholders = (id: string) => {
    for (const dispose of placeholders.get(id) ?? []) dispose()
    placeholders.delete(id)
    registered.delete(id)
  }

  // Manifest-declared contributions are registered eagerly as placeholders so
  // they can trigger lazy activation; the real registrations replace them once
  // the extension activates. Extensions without a web entry stay server-only
  // and contribute nothing to the UI.
  const registerPlaceholders = (item: ExtensionInfo) => {
    // Active extensions manage their own registrations; never tear those down
    // here, just record the definition so reconcile stops re-registering.
    const definition = extensionDefinition(item)
    if (!manager.get(item.id)) clearPlaceholders(item.id)
    registered.set(item.id, definition)
    if (!item.enabled || item.state !== "ready" || mode().disabled) return
    if (!item.web?.entry) return
    const viewerPlaceholders = (item.contributes.fileViewers ?? []).map((viewer) =>
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
            retry={() => retryActivation(item.id)}
          />
        ),
      }),
    )
    const toolPlaceholders = (item.contributes.toolRenderers ?? [])
      .filter((renderer) => {
        if (!isBuiltinToolRenderer(renderer.tool)) return true
        console.warn(`[extension-host] skipping built-in tool renderer id=${item.id} tool=${renderer.tool}`)
        return false
      })
      .map((renderer) => {
        const Placeholder = (props: ToolProps) => {
          onMount(() => {
            if (!failures().has(item.id)) void activate(item.id)
          })
          return <GenericTool {...props} />
        }
        return registerTool({ name: renderer.tool, render: Placeholder })
      })
    const commandPlaceholders = (item.contributes.commands ?? []).map((declared: CommandDeclaration) => {
      const id = extensionCommandID(item.id, declared.id)
      const option: CommandOption = {
        id,
        title: declared.title,
        category: declared.category,
        keybind: declared.keybind,
        slash: declared.slash,
        onSelect: async (source) => {
          await activate(item.id)
          const live = commandOptions().get(id)
          if (live && live !== option) live.onSelect?.(source)
          else console.warn(`[extension-host] command unavailable id=${id}`)
        },
      }
      return putCommandOption(id, option)
    })
    const panelPlaceholders = (item.contributes.panels ?? []).map((declared: PanelDeclaration) => {
      const key = `${item.id}/${declared.id}`
      const Placeholder = (props: ExtensionPanelProps) => {
        onMount(() => {
          if (!failures().has(item.id)) void activate(item.id)
        })
        return (
          <Show
            when={realPanels().get(key)}
            fallback={
              <LoadingViewer
                activate={() => activate(item.id)}
                failed={() => failures().has(item.id)}
                retry={() => retryActivation(item.id)}
              />
            }
          >
            {(component) => <Dynamic component={component()} {...props} />}
          </Show>
        )
      }
      return registerExtensionPanel({
        extensionID: item.id,
        id: declared.id,
        title: declared.title,
        icon: declared.icon,
        component: Placeholder,
      })
    })
    placeholders.set(item.id, [
      ...viewerPlaceholders,
      ...toolPlaceholders,
      ...commandPlaceholders,
      ...panelPlaceholders,
    ])
  }

  // Refreshes are triggered concurrently (provider effect, status events,
  // settings updates). Each refresh bumps the epoch; once a newer one starts,
  // the older one must stop mutating host state instead of overwriting it —
  // reconcileExtensions re-checks the epoch after every await, so a refresh
  // parked on a slow deactivation cannot clobber the newer refresh's state.
  let refreshEpoch = 0
  const reconcile = (next: ExtensionInfo[], epoch: number) =>
    reconcileExtensions(next, {
      manifests: () => manifests(),
      setManifests: (list) => setManifests(list),
      registered,
      deactivate: (id) => manager.deactivate(id),
      clearPlaceholders,
      clearFailure,
      registerPlaceholders,
      activate,
      isStale: () => epoch !== refreshEpoch,
    })

  // State-changing operations (enable/disable, settings updates) share one
  // per-id lock, keyed by the server they were issued against. The tracker is
  // plain and testable; its ids are mirrored into a signal so `mutating` stays
  // reactive for the UI.
  const tracker = createExtensionMutationTracker()
  const [mutatingIDs, setMutatingIDs] = createSignal<ReadonlySet<string>>(new Set())
  const syncMutating = () => setMutatingIDs(new Set(tracker.ids()))
  const beginMutation = (id: string, serverURL: string) => {
    const release = tracker.begin({ serverURL, id })
    syncMutating()
    return () => {
      release()
      syncMutating()
    }
  }

  let activeServerURL = globalSDK.url
  const refresh = async (options?: { strict?: boolean }) => {
    const stale = () => {
      if (options?.strict) throw new ExtensionMutationStaleError("Extension refresh was superseded")
    }
    if (disposed) return stale()
    const epoch = ++refreshEpoch
    const serverURL = globalSDK.url
    const client = globalSDK.client
    if (activeServerURL !== serverURL) {
      // Free locks held against the server we are leaving so an orphaned
      // in-flight toggle cannot keep the id busy on the new server.
      tracker.releaseServer(activeServerURL)
      syncMutating()
      activeServerURL = serverURL
      await manager.disposeAll()
      if (epoch !== refreshEpoch) return stale()
      for (const id of placeholders.keys()) clearPlaceholders(id)
      setManifests([])
      setFailures(new Set<string>())
    }
    if (mode().disabled) {
      if (epoch !== refreshEpoch) return stale()
      await reconcile([], epoch)
      return
    }
    const list = await api.list().then(
      (value) => value,
      (error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[extension-host] manifest refresh failed error=${message}`)
        // Strict callers (post-toggle sync) need the failure to propagate so
        // a swallowed list error cannot turn into a false-green result.
        if (options?.strict) throw error
        return undefined
      },
    )
    if (disposed || globalSDK.client !== client || epoch !== refreshEpoch) return stale()
    if (!list) return
    const applied = await reconcile(list, epoch)
    if (!applied || disposed || globalSDK.client !== client) return stale()
  }

  createEffect(() => {
    if (!safeReady()) return
    globalSDK.url
    mode().disabled
    void refresh()
  })
  const stop = globalSDK.listenAll((event) => {
    // Status events arrive on the shared stream for every connected domain
    // (extra agents included). Only react to events published by the server
    // the extension manifests were loaded from — the current globalSDK url —
    // so a foreign domain's status never mutates this host's state.
    let eventURL: string
    try {
      eventURL = globalSDK.forDomain(event.domain).url
    } catch {
      return
    }
    if (eventURL !== globalSDK.url) return
    if (!event.details || typeof event.details !== "object") return
    const payload = event.details as unknown as ExtensionStatusEvent
    if (payload.type !== "extension.status") return
    if (
      !payload.properties ||
      typeof payload.properties.id !== "string" ||
      typeof payload.properties.state !== "string"
    )
      return
    const id = payload.properties.id
    const state = payload.properties.state
    const eventClient = globalSDK.client
    const eventEpoch = refreshEpoch
    if (state === "disabled") {
      void manager
        .deactivate(id)
        .then(() => {
          // A disable that settles after unmount must not clear state on
          // behalf of a dead host, nor kick off a refresh that would
          // re-register every manifest post-disposal.
          if (disposed || globalSDK.client !== eventClient) return
          if (refreshEpoch !== eventEpoch) return refresh()
          clearFailure(id)
          clearPlaceholders(id)
          return refresh()
        })
        .catch((error) => {
          console.warn(
            `[extension-host] disable cleanup failed id=${id} error=${error instanceof Error ? error.message : String(error)}`,
          )
        })
      return
    }
    if (state === "error") {
      void refresh()
      return
    }
    // Recovery: the extension was reinstalled, re-enabled or changed after an
    // earlier activation failure. Re-fetch the manifests and, once they report
    // the extension as ready again, drop the stale failure so the placeholders
    // can retry activation. Extensions that never failed stay untouched, so
    // lazy on-demand activation keeps working.
    if (failures().has(id)) {
      void refresh()
        .then(() => {
          const item = manifest(id)
          if (!item || !item.enabled || item.state !== "ready" || !failures().has(id)) return
          clearFailure(id)
          return activate(id)
        })
        .catch((error) => {
          console.warn(
            `[extension-host] recovery retry failed id=${id} error=${error instanceof Error ? error.message : String(error)}`,
          )
        })
      return
    }
    void refresh()
  })

  onCleanup(() => {
    disposed = true
    stop()
    // Invalidate any in-flight refresh/reconcile so a pass parked on a slow
    // deactivation cannot re-register placeholders after the host is gone.
    refreshEpoch++
    for (const id of placeholders.keys()) clearPlaceholders(id)
    void manager.disposeAll().catch((error) => {
      console.warn(`[extension-host] dispose failed error=${error instanceof Error ? error.message : String(error)}`)
    })
  })

  const setEnabledByID = async (id: string, enabled: boolean): Promise<{ info: ExtensionInfo; synced: boolean }> => {
    if (mode().disabled) throw new Error(`Extension toggles are unavailable in safe mode: ${id}`)
    if (!manifest(id)) throw new Error(`Extension not found: ${id}`)
    // Capture the connection before the request. After it settles, a changed
    // url or a recreated connection object (an A-B-A back to the same url)
    // means the response belongs to a server this host no longer tracks.
    const serverURL = globalSDK.url
    const connection = globalSDK.client
    const release = beginMutation(id, serverURL)
    try {
      const info = await api.setEnabled({ id, enabled })
      if (disposed) {
        throw new ExtensionMutationStaleError(
          `Extension host was disposed before the ${enabled ? "enable" : "disable"} response arrived: ${id}`,
        )
      }
      if (globalSDK.url !== serverURL || globalSDK.client !== connection) {
        throw new ExtensionMutationStaleError(
          `Extension server changed during ${enabled ? "enable" : "disable"}: ${id}`,
        )
      }
      // The response is the persisted server fact. Invalidate any refresh
      // parked on the pre-toggle view, then run the same reconcile path a
      // refresh uses so placeholders, registrations and signals stay
      // consistent, instead of patching a single signal by hand.
      const epoch = ++refreshEpoch
      const next = manifests().some((item) => item.id === id)
        ? manifests().map((item) => (item.id === id ? info : item))
        : [...manifests(), info]
      await reconcile(next, epoch)
      if (disposed || globalSDK.url !== serverURL || globalSDK.client !== connection) {
        throw new ExtensionMutationStaleError(`Extension server changed during reconciliation: ${id}`)
      }
      // One strict re-read: converge with everything else the toggle changed
      // on the server. A failed re-read must surface as synced=false (the
      // toggle itself still happened and stays applied), never be swallowed
      // into a green result.
      let synced = true
      try {
        await refresh({ strict: true })
      } catch (error) {
        synced = false
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[extension-host] post-toggle sync failed id=${id} error=${message}`)
      }
      if (disposed || globalSDK.url !== serverURL || globalSDK.client !== connection) {
        throw new ExtensionMutationStaleError(`Extension server changed during synchronization: ${id}`)
      }
      return { info: manifest(id) ?? info, synced }
    } finally {
      release()
    }
  }

  const updateSettingsByID = async (id: string, patch: Record<string, unknown>) => {
    const item = manifest(id)
    if (!item) throw new Error(`Extension not found: ${id}`)
    const serverURL = globalSDK.url
    const connection = globalSDK.client
    const release = beginMutation(id, serverURL)
    try {
      const settings = await bridge.updateSettings({ extensionID: id, patch })
      // Late-response guard: this PATCH was issued against the captured
      // server. A response that arrives after the app moved on (url changed,
      // or the connection object was recreated — an A-B-A back to the same
      // url) must not be applied to the new server's state.
      if (disposed)
        throw new ExtensionMutationStaleError(`Extension host was disposed before the settings response arrived: ${id}`)
      if (globalSDK.url !== serverURL || globalSDK.client !== connection) {
        throw new ExtensionMutationStaleError(`Extension server changed during settings update: ${id}`)
      }
      setManifests((current) => current.map((entry) => (entry.id === id ? { ...entry, settings } : entry)))
      const fresh = manifest(id)
      if (!fresh) throw new Error(`Extension manifest disappeared after settings update: ${id}`)
      return fresh
    } finally {
      release()
    }
  }

  const preparedConnections = new WeakMap<PreparedInstallation, { url: string; client: typeof globalSDK.client }>()
  const requireInstallationConnection = (prepared: PreparedInstallation) => {
    const connection = preparedConnections.get(prepared)
    if (disposed || !connection || globalSDK.url !== connection.url || globalSDK.client !== connection.client) {
      throw new ExtensionMutationStaleError("Extension installation belongs to another connection")
    }
    return connection
  }
  const prepareInstallation = async (request: InstallationRequest) => {
    if (mode().disabled) throw new Error("Extension installation is unavailable in safe mode")
    const connection = { url: globalSDK.url, client: globalSDK.client }
    const release = beginMutation("id" in request ? request.id : "@installation", connection.url)
    try {
      const prepared = await installationApi.prepare(request)
      if (disposed || globalSDK.url !== connection.url || globalSDK.client !== connection.client) {
        await createInstallationApi({ client: connection.client })
          .cancel(prepared)
          .catch(() => {})
        throw new ExtensionMutationStaleError("Extension server changed during installation preparation")
      }
      preparedConnections.set(prepared, connection)
      return prepared
    } finally {
      release()
    }
  }
  const commitInstallation = async (prepared: PreparedInstallation, input: { enable?: boolean } = {}) => {
    if (mode().disabled) throw new Error("Extension installation is unavailable in safe mode")
    const connection = requireInstallationConnection(prepared)
    const release = beginMutation(prepared.id, connection.url)
    try {
      const result = await installationApi.commit(prepared, input)
      requireInstallationConnection(prepared)
      await synchronizeInstallation(result, () => refresh({ strict: true }))
      requireInstallationConnection(prepared)
      return result
    } finally {
      release()
    }
  }
  const installationStatus = async (prepared: PreparedInstallation) => {
    requireInstallationConnection(prepared)
    const status = await installationApi.status(prepared)
    requireInstallationConnection(prepared)
    await synchronizeInstallation(status, () => refresh({ strict: true }))
    requireInstallationConnection(prepared)
    return status
  }
  const cancelInstallation = async (prepared: PreparedInstallation) => {
    const connection = preparedConnections.get(prepared)
    if (!connection) throw new ExtensionMutationStaleError("Unknown extension preparation")
    // Closing a preview after switching servers must cancel on its original
    // client, never redirect the capability to the newly connected server.
    return createInstallationApi({ client: connection.client }).cancel(prepared)
  }

  const value: ExtensionHost = {
    activate,
    refresh,
    enabled: () => !mode().disabled,
    extensions: manifests,
    updateSettings: updateSettingsByID,
    setEnabled: setEnabledByID,
    mutating: (id) => mutatingIDs().has(id),
    prepareInstallation,
    commitInstallation,
    installationStatus,
    cancelInstallation,
  }
  return <ExtensionHostContext.Provider value={value}>{props.children}</ExtensionHostContext.Provider>
}

export function useExtensionHost() {
  const value = useContext(ExtensionHostContext)
  if (!value) throw new Error("useExtensionHost must be used within ExtensionHostProvider")
  return value
}
