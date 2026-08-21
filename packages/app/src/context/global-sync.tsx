import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import {
  getOwner,
  createEffect,
  createSignal,
  onCleanup,
  on,
  type ParentProps,
  untrack,
} from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import type { InitError } from "../pages/error"
import { GlobalSyncProvider as GlobalSyncContextProvider, useGlobalSync } from "./global-sync-context"
import { useGlobalSDK } from "./global-sdk"
import { bootstrapDirectory, bootstrapGlobal } from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./global-sync/event-reducer"
import { createRefreshQueue } from "./global-sync/queue"
import { clearSessionPrefetch, clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { loadRootSessions } from "./global-sync/session-load"
import { sessionDataMutation } from "./global-sync/session-data-event"
import { createSessionService } from "./global-sync/session-service"
import type { SessionChildStore } from "./global-sync/session-service-types"
import {
  shouldRefreshSessionStatusOnVisibility,
  type SessionStatusRefreshReason,
} from "./global-sync/session-status-refresh"
import type { ProjectMeta } from "./global-sync/types"
import { normalizeProviderList, sanitizeProject, stripProvider } from "./global-sync/utils"
import { formatServerError, permissionNotice } from "@/utils/server-errors"
import { useServer } from "./server"
import {
  domainFromDirectory,
  extraAgentByIntegration,
  isExtraAgentIntegration,
  mainDomain,
  type DomainId,
} from "@/pages/layout/extra-agents"
import { workspaceKey } from "@/pages/layout/helpers"

export type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  rootByDomain: Partial<
    Record<
      DomainId,
      Omit<GlobalStore, "projectByDomain" | "project" | "rootByDomain">
    >
  >
  projectByDomain: Partial<Record<DomainId, Project[]>>
  project: Project[]
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const server = useServer()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")
  const [version, setVersion] = createSignal(0)

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionLoaded = new Set<string>()
  const providerRefreshes = new Map<DomainId, Promise<ProviderListResponse>>()
  const revs = new Map<string, number>()
  const queues = new Map<DomainId, ReturnType<typeof createRefreshQueue>>()
  const bootedAt = new Map<DomainId, number>()
  const bootingRoot = new Map<DomainId, boolean>()

  const currentDomain = () => server.domain
  let clearSessionControllers = (_directory: string) => {}
  const rev = (directory: string) => revs.get(directory) ?? 0
  const bump = (directory: string, why: string) => {
    const next = rev(directory) + 1
    revs.set(directory, next)
    return next
  }
  const blankRoot = () => ({
    ready: false,
    error: undefined as InitError | undefined,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    provider: { all: [], connected: [], default: {} } as ProviderListResponse,
    provider_auth: {} as ProviderAuthResponse,
    config: {} as Config,
    reload: undefined as undefined | "pending" | "complete",
  })
  const rootBucket = (domain = currentDomain()) => globalStore.rootByDomain[domain] ?? blankRoot()
  const projectBucket = (domain = currentDomain()) => globalStore.projectByDomain[domain] ?? []
  const runtime = (domain = currentDomain()) => globalSDK.forDomain(domain)

  const [projectCache, setProjectCache, projectInit] = persisted(
    {
      ...Persist.global("globalSync.project", ["globalSync.project.v1"]),
      migrate(value) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return { domains: { [mainDomain]: [] as Project[] } }
        if ("domains" in value) return value
        const list = Array.isArray((value as { value?: unknown }).value)
          ? ((value as { value: Project[] }).value ?? [])
          : []
        return { domains: { [mainDomain]: list } }
      },
    },
    createStore({ domains: { [mainDomain]: [] as Project[] } as Partial<Record<DomainId, Project[]>> }),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    ...blankRoot(),
    rootByDomain: {},
    projectByDomain: projectCache.domains,
    project: projectCache.domains[mainDomain] ?? [],
  })
  const [loaded, setLoaded] = createStore({ dir: {} as Record<string, true> })

  let active = true
  let projectWritten = false
  let prevServer = server.current?.integration
  let prevSDKVersion = globalSDK.version
  // A directory is only "isolated" (skip bootstrap/load/event application) when its
  // domain has no registered server to talk to. Visible-domain no longer gates hidden
  // domains; each domain runs in parallel so long as it has an active server.
  const isolated = (directory: string) => !server.currentFor(domainFromDirectory(directory))

  onCleanup(() => {
    active = false
  })

  createEffect(
    on(
      currentDomain,
      (domain) => {
        const root = rootBucket(domain)
        setGlobalStore("ready", root.ready)
        setGlobalStore("error", root.error)
        setGlobalStore("path", reconcile(root.path))
        setGlobalStore("provider", reconcile(root.provider))
        setGlobalStore("provider_auth", reconcile(root.provider_auth))
        setGlobalStore("config", reconcile(root.config))
        setGlobalStore("reload", root.reload)
        setGlobalStore("project", reconcile(projectBucket(domain)))
      },
      { defer: false },
    ),
  )

  const cacheProjects = (domain = currentDomain()) => {
    setProjectCache(
      "domains",
      domain,
      untrack(() => projectBucket(domain).map(sanitizeProject)),
    )
  }

  const setProjectsFor = (domain: DomainId, next: Project[] | ((draft: Project[]) => void)) => {
    projectWritten = true
    if (typeof next === "function") {
      const mutate = next
      setGlobalStore(
        "projectByDomain",
        domain,
        produce<Project[] | undefined>((draft) => {
          if (!draft) return
          mutate(draft)
        }),
      )
      if (domain === currentDomain()) setGlobalStore("project", produce(mutate))
      cacheProjects(domain)
      return
    }
    setGlobalStore("projectByDomain", domain, next)
    if (domain === currentDomain()) setGlobalStore("project", next)
    cacheProjects(domain)
  }

  const setProjects = (next: Project[] | ((draft: Project[]) => void)) => setProjectsFor(currentDomain(), next)

  const setRoot = (domain: DomainId, key: keyof ReturnType<typeof blankRoot>, value: unknown) => {
    setGlobalStore(
      "rootByDomain",
      produce((draft) => {
        const root = draft[domain] ?? blankRoot()
        draft[domain] = {
          ...root,
          [key]: value,
        }
      }),
    )
    if (domain !== currentDomain()) return
    ;(setGlobalStore as (...args: unknown[]) => unknown)(key, value)
  }

  const updateGlobalConfig = (domain: DomainId, config: Config) => {
    setRoot(domain, "config", config)
  }

  const configAffectsProviders = (config: Config) =>
    "provider" in config || "disabled_providers" in config || "enabled_providers" in config

  const bootStoreFor = (domain: DomainId) =>
    ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjectsFor(domain, input[1] as Project[])
      return input[1]
    }
    if (
      typeof input[0] === "string" &&
      ["ready", "error", "path", "provider", "provider_auth", "config", "reload"].includes(input[0])
    ) {
      setRoot(domain, input[0] as keyof ReturnType<typeof blankRoot>, input[1])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => void))
      return input[1]
    }
    if (
      typeof input[0] === "string" &&
      ["ready", "error", "path", "provider", "provider_auth", "config", "reload"].includes(input[0])
    ) {
      setRoot(currentDomain(), input[0] as keyof ReturnType<typeof blankRoot>, input[1])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  if (projectInit instanceof Promise) {
    void projectInit.then(() => {
      if (!active) return
      if (projectWritten) return
      const cached = projectCache.domains[currentDomain()] ?? []
      if (cached.length === 0) return
      setGlobalStore("projectByDomain", currentDomain(), cached)
      setGlobalStore("project", cached)
    })
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined
  const queueFor = (domain = currentDomain()) => {
    const existing = queues.get(domain)
    if (existing) return existing
    const queue = createRefreshQueue({
      paused,
      bootstrap: () => bootstrap(domain),
      bootstrapInstance,
    })
    queues.set(domain, queue)
    return queue
  }

  type ChildManager = ReturnType<typeof createChildStoreManager>
  const managers = new Map<DomainId, ChildManager>()
  const managerFor = (domain: DomainId): ChildManager => {
    const cached = managers.get(domain)
    if (cached) return cached
    const manager = createChildStoreManager({
      owner,
      isBooting: (directory) => booting.has(directory),
      isLoadingSessions: (directory) => sessionLoads.has(directory),
      onBootstrap: (directory) => {
        void bootstrapInstance(directory).catch((err) => {
          console.error(
            `[global-sync] bootstrap trigger failed directory=${directory} err=${err instanceof Error ? err.message : String(err)}`,
          )
        })
      },
      onDispose: (directory) => {
        bump(directory, "dispose")
        queueFor(domain).clear(directory)
        sessionLoaded.delete(directory)
        clearSessionControllers(directory)
        sdkCache.delete(directory)
        clearSessionPrefetchDirectory(directory)
        setLoaded(
          "dir",
          produce((draft) => {
            delete draft[directory]
          }),
        )
        revs.delete(directory)
        console.debug(`[global-sync] instance dispose requested directory=${directory} domain=${domain}`)
        void runtime(domain)
          .client.instance.dispose({ directory })
          .then(() => {
            console.debug(`[global-sync] instance dispose succeeded directory=${directory} domain=${domain}`)
          })
          .catch((err) => {
            console.warn(
              `[global-sync] instance dispose failed directory=${directory} domain=${domain} err=${err instanceof Error ? err.message : String(err)}`,
            )
          })
      },
      translate: language.t,
    })
    managers.set(domain, manager)
    return manager
  }
  // Child stores are keyed by one canonical directory representation. SDK wire
  // formatting is deliberately separate, so Windows slash variants share state.
  const storeKey = (directory: string) => workspaceKey(directory)
  const managerOf = (directory: string): ChildManager => managerFor(domainFromDirectory(storeKey(directory)))
  const forEachDirectory = (visit: (directory: string, manager: ChildManager) => void) => {
    for (const manager of managers.values()) {
      for (const directory of Object.keys(manager.children)) {
        visit(directory, manager)
      }
    }
  }
  const directoriesInDomain = (domain: DomainId) => {
    const manager = managers.get(domain)
    if (!manager) return [] as string[]
    return Object.keys(manager.children)
  }

  // Event streams may use a realpath/normalized directory while child stores are
  // keyed by the route/worktree string. Resolve by exact key first, then workspaceKey
  // and the store's path.directory so external writers (e.g. scheduled tasks) still
  // update the open session UI.
  const resolveChild = (directory: string) => {
    const manager = managerOf(directory)
    const key = storeKey(directory)
    const exact = manager.children[key]
    if (exact) return { key, child: exact, manager, domain: domainFromDirectory(key) }

    const want = workspaceKey(directory)
    if (!want) return

    for (const manager of managers.values()) {
      for (const [key, child] of Object.entries(manager.children)) {
        if (workspaceKey(key) === want) {
          return { key, child, manager, domain: domainFromDirectory(key) }
        }
        const pathDir = child[0].path?.directory
        if (pathDir && workspaceKey(pathDir) === want) {
          return { key, child, manager, domain: domainFromDirectory(key) }
        }
      }
    }
  }
  const children = {
    child: (directory: string, options?: Parameters<ChildManager["child"]>[1]) =>
      managerOf(directory).child(storeKey(directory), options),
    peek: (directory: string, options?: Parameters<ChildManager["peek"]>[1]) =>
      managerOf(directory).peek(storeKey(directory), options),
    ensureChild: (directory: string) => managerOf(directory).ensureChild(storeKey(directory)),
    pin: (directory: string) => managerOf(directory).pin(storeKey(directory)),
    unpin: (directory: string) => managerOf(directory).unpin(storeKey(directory)),
    mark: (directory: string) => managerOf(directory).mark(storeKey(directory)),
    disposeDirectory: (directory: string) => managerOf(directory).disposeDirectory(storeKey(directory)),
    resetDirectory: (directory: string) => managerOf(directory).resetDirectory(storeKey(directory)),
    projectMeta: (directory: string, patch: ProjectMeta) => managerOf(directory).projectMeta(storeKey(directory), patch),
    projectIcon: (directory: string, value: string | undefined) =>
      managerOf(directory).projectIcon(storeKey(directory), value),
    lookup: (directory: string) => managerOf(directory).children[storeKey(directory)],
    vcsCache: {
      get: (directory: string) => managerOf(directory).vcsCache.get(storeKey(directory)),
    },
  }

  const sdkFor = (directory: string) => {
    const key = storeKey(directory)
    const cached = sdkCache.get(key)
    if (cached) {
      console.debug(`[global-sync] sdkFor cache hit directory=${directory}`)
      return cached
    }
    console.log(`[global-sync] sdkFor creating directory=${directory}`)
    const sdk = runtime(domainFromDirectory(directory)).createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const sessionService = createSessionService({
      canonical: storeKey,
      isolated,
      sdk: sdkFor,
      child: (directory) => children.peek(directory, { bootstrap: false }) as SessionChildStore,
      current: (directory, child, revision) =>
        rev(directory) === revision && managerOf(directory).children[directory] === child,
      revision: rev,
      pin: children.pin,
      unpin: children.unpin,
    })
  clearSessionControllers = sessionService.clearDirectory

  async function refreshConfig(domain = currentDomain()): Promise<Config> {
    const refreshed = await runtime(domain).client.global.config.refresh()
    if (!refreshed.data) throw new Error(language.t("common.requestFailed"))
    const result = await runtime(domain).client.config.get()
    const next = result.data
    if (!next) throw new Error(language.t("common.requestFailed"))
    updateGlobalConfig(domain, next)
    return next
  }

  /** Boundary-only: refresh status for every currently loaded directory store. */
  function refreshLoadedSessionStatuses(reason: SessionStatusRefreshReason) {
    forEachDirectory((directory) => {
      if (!loaded.dir[directory]) return
      void sessionService.api.status.refresh(directory, reason)
    })
  }

  const sessionApi = {
    ...sessionService.api,
    status: {
      ...sessionService.api.status,
      refreshLoaded: refreshLoadedSessionStatuses,
    },
  }

  // Long background → foreground: event stream may have stalled; reconcile once.
  // Not a poll — only when hidden long enough (see SESSION_STATUS_VISIBILITY_REFRESH_MS).
  let sessionStatusHiddenAt: number | undefined
  if (typeof document !== "undefined") {
    if (document.visibilityState === "hidden") sessionStatusHiddenAt = Date.now()
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        sessionStatusHiddenAt = Date.now()
        return
      }
      const hiddenAt = sessionStatusHiddenAt
      sessionStatusHiddenAt = undefined
      if (hiddenAt === undefined) return
      if (!shouldRefreshSessionStatusOnVisibility(Date.now() - hiddenAt)) return
      refreshLoadedSessionStatuses("visibility")
    }
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibility))
  }

  async function loadSessions(
    directory: string,
    opts?: { silent?: boolean; force?: boolean },
  ): Promise<void> {
    directory = storeKey(directory)
    if (isolated(directory)) {
      return
    }
    const pending = sessionLoads.get(directory)
    if (pending) {
      if (opts?.force) {
        return pending.then(() => loadSessions(directory, { ...opts, force: true }))
      }
      return pending
    }

    children.pin(directory)
    const child = children.peek(directory, { bootstrap: false })
    const mark = rev(directory)
    const raw = child[1] as (...args: unknown[]) => unknown
    const store = child[0]
    const setStore = ((...input: unknown[]) => {
      if (rev(directory) !== mark || managerOf(directory).children[directory] !== child) return input[0]
      return raw(...input)
    }) as typeof child[1]
    if (!opts?.force && sessionLoaded.has(directory)) {
      setStore("sessions", "ready")
      setStore("session_error", undefined)
      children.unpin(directory)
      return
    }
    if (opts?.force) sessionLoaded.delete(directory)

    const startedAt = Date.now()
    console.debug(
      `[global-sync] load sessions start directory=${directory} force=${opts?.force ? 1 : 0} silent=${opts?.silent ? 1 : 0}`,
    )
    setStore("sessions", "loading")
    setStore("session_error", undefined)

    const promise = loadRootSessions({
      directory,
      list: (query) => {
        console.log(`[global-sync] loadSessions list query directory=${directory} roots=${query.roots}`)
        const sdk = sdkFor(directory)
        console.log(`[global-sync] loadSessions using sdk directory=${(sdk as any).directory}`)
        return sdk.session.list(query)
      },
    })
      .then((x) => {
        const nonArchived = (x.data ?? [])
          .filter((s) => !!s?.id)
          .filter((s) => !s.time?.archived)
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const childSessions = store.session.filter((s) => !!s.parentID)
        const sessions = [...nonArchived, ...childSessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const total = nonArchived.length
        setStore("sessionTotal", total)
        // Keep the directory cache complete. Sidebar views own visible limits,
        // so clipping here would let whichever view loads first hide newer rows.
        setStore("session", reconcile(sessions, { key: "id" }))
        const stale = cleanupDroppedSessionCaches(store, setStore, sessions)
        if (stale.length > 0) {
          clearSessionPrefetch(directory, stale)
          sessionService.api.clear(directory, stale)
        }
        sessionLoaded.add(directory)
        setStore("sessions", "ready")
        setStore("session_error", undefined)
        setLoaded("dir", directory, true)
        console.debug(
          `[global-sync] load sessions success directory=${directory} roots=${total} sessions=${sessions.length} elapsed=${Date.now() - startedAt}ms`,
        )
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          `[global-sync] failed to load sessions directory=${directory} elapsed=${Date.now() - startedAt}ms err=${message}`,
        )
        setStore("sessions", "idle")
        const note = permissionNotice(err, language.t, "session")
        setStore("session_error", note)
        if (opts?.silent || note) return
        const project = getFilename(directory)
        const agent = extraAgentByIntegration(server.current?.integration)
        const title = agent?.sessionListFailedTitleKey
          ? language.t(agent.sessionListFailedTitleKey)
          : language.t("toast.session.listFailed.title", { project })
        showToast({
          variant: "error",
          title,
          description: formatServerError(err, language.t),
        })
      })

    sessionLoads.set(directory, promise)
    promise.finally(() => {
      console.debug(`[global-sync] load sessions done directory=${directory} elapsed=${Date.now() - startedAt}ms`)
      sessionLoads.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  async function refreshProviders(domain = currentDomain()) {
    const pending = providerRefreshes.get(domain)
    if (pending) return pending

    const promise = (async () => {
      const started = performance.now()
      const directory = rootBucket(domain).path.directory || globalStore.path.directory
      console.info(
        `[config-perf] provider refresh start domain=${domain} directory=${directory || "(none)"} t=${started.toFixed(1)}`,
      )
      const rt = runtime(domain)
      const client = directory ? rt.createClient({ directory }) : rt.client
      const result = await client.provider.list()
      const listedAt = performance.now()
      const data = normalizeProviderList(result.data!)
      setRoot(domain, "provider", data)
      console.info(
        `[config-perf] provider refresh listed all=${String(data.all.length)} connected=${String(data.connected.length)} listMs=${(listedAt - started).toFixed(1)} totalMs=${(performance.now() - started).toFixed(1)}`,
      )

      const manager = managers.get(domain)
      if (manager) {
        void Promise.allSettled(
          Object.keys(manager.children).map(async (childDirectory) => {
            if (isolated(childDirectory)) return
            const next = await sdkFor(childDirectory).provider.list()
            const child = manager.children[childDirectory]
            if (!child) return
            child[1]("provider", normalizeProviderList(next.data!))
          }),
        )
      }

      return data
    })()

    providerRefreshes.set(domain, promise)
    void promise.then(
      () => providerRefreshes.delete(domain),
      () => providerRefreshes.delete(domain),
    )
    return promise
  }

  async function bootstrapInstance(directory: string) {
    directory = storeKey(directory)
    if (!directory) return
    if (isolated(directory)) {
      return
    }
    const pending = booting.get(directory)
    if (pending) {
      return pending
    }

    children.pin(directory)
    const promise = (async () => {
      const child = children.ensureChild(directory)
      const mark = rev(directory)
      const raw = child[1] as (...args: unknown[]) => unknown
      const setStore = ((...input: unknown[]) => {
        if (rev(directory) !== mark || managerOf(directory).children[directory] !== child) return input[0]
        return raw(...input)
      }) as typeof child[1]
      const cache = children.vcsCache.get(directory)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          project: projectBucket(domainFromDirectory(directory)),
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore,
        setProject: (projects) => setProjectsFor(domainFromDirectory(directory), projects),
        vcsCache: cache,
        translate: language.t,
      })
      setLoaded("dir", directory, true)
    })()

    booting.set(directory, promise)
    promise.finally(() => {
      booting.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  const unsub = globalSDK.listenAll((e) => {
    const directory = e.name
    const event = e.details
    const emittingDomain = e.domain
    const dirDomain = directory === "global" ? emittingDomain : domainFromDirectory(directory)
    const recent = !!bootingRoot.get(dirDomain) || Date.now() - (bootedAt.get(dirDomain) ?? 0) < 1500

    if (directory === "global") {
      // Route to the emitting domain's bucket regardless of which domain is visible.
      // Hidden domains must continue to process their own global events.
      applyGlobalEvent({
        event,
        project: projectBucket(emittingDomain),
        refresh: () => {
          if (recent) return
          // Extra-agent server.connected should not trigger a full main-domain bootstrap.
          // Only the main domain's own events should refresh the main domain.
          if (emittingDomain !== mainDomain) {
            return
          }
          queueFor(emittingDomain).refresh()
        },
        setGlobalProject: (next) => setProjectsFor(emittingDomain, next),
        setGlobalConfig: (config) => updateGlobalConfig(emittingDomain, config),
      })
      if (event.type === "global.config.updated") {
        void refreshProviders(emittingDomain).catch((err) => {
          console.error(`[global-sync] provider refresh failed error=${err instanceof Error ? err.message : String(err)}`)
        })
        return
      }
      if (event.type === "server.connected" || event.type === "global.disposed") {
        if (recent) return
        // For the main domain, refresh() already calls bootstrap() which handles all directories.
        // Only push individual directories for extra-agent domains where refresh() is skipped.
        if (emittingDomain !== mainDomain) {
          for (const directory of directoriesInDomain(emittingDomain)) {
            if (!loaded.dir[directory]) continue
            queueFor(emittingDomain).push(directory)
          }
        }
      }
      return
    }

    // Cross-domain event bleed guard: a directory event coming from a different
    // domain than the directory itself is a bug — drop it instead of applying.
    if (emittingDomain !== dirDomain) return
    if (isolated(directory)) return
    const resolved = resolveChild(directory)
    if (!resolved) return
    const { key, child, domain: resolvedDomain } = resolved
    children.mark(key)
    const [store, setStore] = child
    // Re-broadcast under the store key so SDKProvider listeners subscribed to the
    // route directory still receive events when the wire path is a realpath alias.
    if (key !== directory) {
      globalSDK.eventFor(resolvedDomain).emit(key, event)
    }
    const mutation = sessionDataMutation(event, (messageID) => {
      const part = store.part[messageID]?.find((item) => item.sessionID)
      if (part?.sessionID) return part.sessionID
      for (const [sessionID, messages] of Object.entries(store.message)) {
        if (messages?.some((message) => message.id === messageID)) return sessionID
      }
    })
    if (mutation) sessionService.event(key, mutation)
    const removedSession = (() => {
      if (event.type === "session.deleted") return (event.properties as { info?: { id?: string } }).info?.id
      if (event.type !== "session.updated") return
      const info = (event.properties as { info?: { id?: string; time?: { archived?: number } } }).info
      return info?.time?.archived ? info.id : undefined
    })()
    if (removedSession) {
      clearSessionPrefetch(key, [removedSession])
      sessionService.api.clear(key, [removedSession])
    }
    try {
      applyDirectoryEvent({
        event,
        directory: key,
        store,
        setStore,
        push: queueFor(resolvedDomain).push,
        vcsCache: children.vcsCache.get(key),
        loadLsp: () => {
          sdkFor(key)
            .lsp.status()
            .then((x) => setStore("lsp", x.data ?? []))
        },
      })
    } catch (err) {
      const props = (event as { properties?: unknown }).properties as
        | {
            messageID?: string
            partID?: string
            part?: { id?: string; messageID?: string; type?: string }
          }
        | undefined
      console.error(
        `[global-sync] directory event failed directory=${directory} resolved=${key} domain=${resolvedDomain} type=${event.type} recent=${recent ? 1 : 0} status=${store.status} sessions=${store.sessions} path=${store.path.directory} messageID=${props?.messageID ?? props?.part?.messageID ?? ""} partID=${props?.partID ?? props?.part?.id ?? ""} partType=${props?.part?.type ?? ""} err=${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  })

  onCleanup(unsub)
  onCleanup(() => {
    for (const queue of queues.values()) queue.dispose()
    queues.clear()
  })
  onCleanup(() => {
    forEachDirectory((directory, manager) => {
      manager.disposeDirectory(directory)
    })
  })

  async function bootstrap(domain = currentDomain()) {
    bootingRoot.set(domain, true)
    try {
      await bootstrapGlobal({
        globalSDK: runtime(domain).client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: bootStoreFor(domain),
      })
      await Promise.allSettled(
        directoriesInDomain(domain)
          .filter((directory) => loaded.dir[directory])
          .map((directory) => bootstrapInstance(directory)),
      )
      bootedAt.set(domain, Date.now())
    } finally {
      bootingRoot.set(domain, false)
    }
  }

  createEffect(
    on(
      () => globalSDK.version,
      () => {
        const nextSDKVersion = globalSDK.version
        const nextServer = server.current?.integration
        const prevDomain = prevServer
          ? isExtraAgentIntegration(prevServer)
            ? `extra-agent/${prevServer}`
            : mainDomain
          : mainDomain
        const nextDomain = server.domain
        const domainSwitch = prevDomain !== nextDomain
        const serverChanged = prevServer !== nextServer
        const connectionChanged = prevSDKVersion !== nextSDKVersion
        prevServer = nextServer
        prevSDKVersion = nextSDKVersion
        const dirs = directoriesInDomain(nextDomain)
        if (!domainSwitch && (serverChanged || connectionChanged)) {
          sessionService.clearDomain(nextDomain)
          for (const dir of dirs) {
            booting.delete(dir)
            sessionLoads.delete(dir)
            sessionLoaded.delete(dir)
            sessionService.clearDirectory(dir)
            bump(dir, "server-reset")
          }
        }
        for (const directory of dirs) {
          if (!managerFor(nextDomain).children[directory]) continue
          if (!domainSwitch && (serverChanged || connectionChanged)) {
            queueFor(nextDomain).clear(directory)
            sdkCache.delete(directory)
            clearSessionPrefetchDirectory(directory)
            children.resetDirectory(directory)
          }
        }
        setGlobalStore("reload", undefined)
        setVersion((x) => x + 1)
        if (!domainSwitch && (serverChanged || connectionChanged)) void bootstrap(nextDomain)
      },
    ),
  )

  const projectApi = {
    loadSessions,
    warm(directory: string) {
      void bootstrapInstance(directory)
    },
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const providerApi = {
    refresh: refreshProviders,
    remove(id: string) {
      if (!id) return
      setGlobalStore("provider", (prev) => stripProvider(prev, id))
      forEachDirectory((directory, manager) => {
        const child = manager.children[directory]
        if (!child) return
        child[1]("provider", (prev) => stripProvider(prev, id))
      })
    },
  }

  const updateConfig = async (config: Config, options?: { refreshProviders?: boolean }) => {
    const domain = currentDomain()
    const refreshProviderState = options?.refreshProviders ?? configAffectsProviders(config)
    setRoot(domain, "reload", "pending")
    // Capture channels we intend to write so we can re-apply after response/SSE.
    const writtenChannels = config.channels
    return runtime(domain)
      .client.global.config.update({ config })
      .then(async (result) => {
        let next = result.data!
        // Server response / OpenAPI encode can drop newly-added nested fields
        // (or race with global.config.updated). Prefer the client's write for channels.
        if (writtenChannels) {
          const merged: NonNullable<Config["channels"]> = { ...(next.channels ?? {}) }
          for (const [name, entry] of Object.entries(writtenChannels)) {
            merged[name] = { ...(next.channels?.[name] as object | undefined), ...entry } as NonNullable<
              Config["channels"]
            >[string]
          }
          // Deletions: if client sent a map missing keys that existed only as a full replace
          // of the channels object, use writtenChannels as the authority when it is a full map.
          next = { ...next, channels: { ...writtenChannels, ...merged, ...writtenChannels } }
        }
        updateGlobalConfig(domain, next)
        if (refreshProviderState) {
          await refreshProviders(domain)
        }
        return next
      })
      .finally(() => {
        setRoot(domain, "reload", undefined)
      })
  }

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get version() {
      return version()
    },
    get error() {
      return globalStore.error
    },
    loaded(directory: string) {
      return !!loaded.dir[directory]
    },
    child: children.child,
    peek: children.peek,
    bootstrap,
    refreshConfig,
    updateConfig,
    provider: providerApi,
    project: projectApi,
    session: sessionApi,
  }
}

export { createGlobalSync, useGlobalSync }

export function useQueryOptions() {
  return {
    mcp: (directory: string) => ({ queryKey: [directory, "mcp"] as const }),
    lsp: (directory: string) => ({ queryKey: [directory, "lsp"] as const }),
    agents: (directory: string) => ({ queryKey: [directory, "agents"] as const }),
    providers: (directory: string | null) => ({ queryKey: [directory, "providers"] as const }),
    path: (directory: string | null) => ({ queryKey: [directory, "path"] as const }),
    sessions: (directory: string) => ({ queryKey: [directory, "loadSessions"] as const }),
    projects: () => ({ queryKey: ["projects"] as const }),
    globalConfig: () => ({ queryKey: ["globalConfig"] as const }),
  }
}

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return <GlobalSyncContextProvider value={value}>{props.children}</GlobalSyncContextProvider>
}
