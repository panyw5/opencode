import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { useCheckServerHealth } from "@/utils/server-health"
import {
  domainFromIntegration,
  extraAgentByDirectory,
  isExtraAgentIntegration,
  mainDomain,
  type DomainId,
  type ExtraAgentId,
} from "@/pages/layout/extra-agents"
import { sameWorkspacePath, workspaceKey, workspacePathAliases } from "@/pages/layout/helpers"

type StoredProject = { worktree: string; expanded: boolean }
type StoredServer = string | ServerConnection.HttpBase | ServerConnection.Http
type StoredState = {
  list: StoredServer[]
  projects: Record<string, StoredProject[]>
  lastProject: Record<string, string>
  currentSidecarUrl?: string
}
const HEALTH_POLL_INTERVAL_MS = 10_000

export function normalizeServerUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withProtocol.replace(/\/+$/, "")
}

export function serverName(conn?: ServerConnection.Any, ignoreDisplayName = false) {
  if (!conn) return ""
  if (conn.displayName && !ignoreDisplayName) return conn.displayName
  return conn.http.url.replace(/^https?:\/\//, "").replace(/\/+$/, "")
}

export function projectsKey(key: string) {
  if (!key) return ""
  if (key === "sidecar") return "local"
  if (isLocalHost(key)) return "local"
  return key
}

/** List/persist bucket for the project rail. Prefer the resolved connection key. */
export function resolveProjectsListKey(input: {
  active: string
  currentKey?: string
  currentIntegration?: string
}) {
  if (isExtraAgentIntegration(input.currentIntegration)) return input.currentIntegration
  if (input.currentKey) return projectsKey(input.currentKey)
  return projectsKey(input.active)
}

function hostnameFromUrl(input: string) {
  try {
    const normalized = /^https?:\/\//.test(input) ? input : `http://${input}`
    return new URL(normalized).hostname
  } catch {
    return
  }
}

function isLocalHost(url: string) {
  const host = hostnameFromUrl(url)
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "local"
}

function isPersistedLoopbackHttpServer(value: StoredServer) {
  const candidate = typeof value === "string" ? value : "type" in value ? value.http.url : value.url
  const normalized = /^https?:\/\//.test(candidate) ? candidate : `http://${candidate}`
  const host = hostnameFromUrl(candidate)
  if (!host) return false
  if (!normalized.startsWith("http://")) return false
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
}

export function resolveServerList(input: {
  props?: Array<ServerConnection.Any>
  stored: StoredServer[]
}): Array<ServerConnection.Any> {
  const servers = [
    ...input.stored.map((value) =>
      typeof value === "string"
        ? {
            type: "http" as const,
            http: { url: value },
          }
        : value,
    ),
    ...(input.props ?? []),
  ]

  const deduped = new Map<ServerConnection.Key, ServerConnection.Any>()
  for (const value of servers) {
    const conn: ServerConnection.Any = "type" in value ? value : { type: "http", http: value }
    const key = ServerConnection.key(conn)
    if (deduped.has(key) && conn.type === "http" && !conn.authToken) continue
    deduped.set(key, conn)
  }

  return [...deduped.values()]
}

export namespace ServerConnection {
  type Base = { displayName?: string; integration?: ExtraAgentId }

  export type HttpBase = {
    url: string
    username?: string
    password?: string
  }

  // Regular web connections
  export type Http = {
    type: "http"
    http: HttpBase
    authToken?: boolean
  } & Base

  export type Sidecar = {
    type: "sidecar"
    http: HttpBase
  } & (
    | // Regular desktop server
    { variant: "base" }
    // WSL server (windows only)
    | {
        variant: "wsl"
        distro: string
      }
  ) &
    Base

  // Remote server desktop can SSH into
  export type Ssh = {
    type: "ssh"
    host: string
    // SSH client exposes an HTTP server for the app to use as a proxy
    http: HttpBase
  } & Base

  export type Any =
    | Http
    // All these are desktop-only
    | (Sidecar | Ssh)

  export const key = (conn: Any): Key => {
    switch (conn.type) {
      case "http":
        if (isExtraAgentIntegration(conn.integration)) return Key.make(`extra-agent:${conn.integration}`)
        return Key.make(conn.http.url)
      case "sidecar": {
        if (conn.variant === "wsl") return Key.make(`wsl:${conn.distro}`)
        return Key.make("sidecar")
      }
      case "ssh":
        return Key.make(`ssh:${conn.host}`)
    }
  }

  export type Key = string & { _brand: "Key" }
  export const Key = { make: (v: string) => v as Key }
}

export const { use: useServer, provider: ServerProvider } = createSimpleContext({
  name: "Server",
  init: (props: { defaultServer: ServerConnection.Key; servers?: Array<ServerConnection.Any> }) => {
    const checkServerHealth = useCheckServerHealth()

    const [store, setStore, _, ready] = persisted(
      Persist.global("server", ["server.v3"]),
      createStore({
        list: [] as StoredServer[],
        projects: {} as Record<string, StoredProject[]>,
        lastProject: {} as Record<string, string>,
        currentSidecarUrl: undefined as string | undefined,
      } satisfies StoredState),
    )

    const url = (x: StoredServer) => (typeof x === "string" ? x : "type" in x ? x.http.url : x.url)
    const storedList = () => (Array.isArray(store.list) ? store.list : [])
    const storedProjects = () =>
      store.projects && typeof store.projects === "object" && !Array.isArray(store.projects) ? store.projects : {}
    const storedLastProject = () =>
      store.lastProject && typeof store.lastProject === "object" && !Array.isArray(store.lastProject)
        ? store.lastProject
        : {}
    const propServers = () => (Array.isArray(props.servers) ? props.servers : [])

    const allServers = createMemo((): Array<ServerConnection.Any> => {
      const provided = propServers()
      const sidecar = provided.find((item) => item.type === "sidecar" && item.variant === "base")
      const legacy = store.currentSidecarUrl
      const servers = [
        ...provided,
        ...storedList().flatMap((value) => {
          if (isPersistedLoopbackHttpServer(value)) {
            return []
          }
          const conn =
            typeof value === "string"
              ? ({
                  type: "http" as const,
                  http: { url: value },
                } satisfies ServerConnection.Http)
              : "type" in value
                ? value
                : ({
                    type: "http" as const,
                    http: value,
                  } satisfies ServerConnection.Http)
          if (legacy && sidecar && conn.type === "http" && conn.http.url === legacy) {
            return []
          }
          return [conn]
        }),
      ]

      const deduped = new Map(
        servers.map((value) => {
          return [ServerConnection.key(value), value]
        }),
      )

      return [...deduped.values()]
    })

    const [state, setState] = createStore({
      active: props.defaultServer,
      lastNonExtraAgent: props.defaultServer,
      healthyByDomain: {} as Partial<Record<DomainId, boolean | undefined>>,
    })
    const trace = (_event: string, _extra?: Record<string, unknown>) => {}

    const healthyFor = (input: DomainId) => state.healthyByDomain[input]
    const healthy = () => healthyFor(domain())

    function startHealthPolling(conn: ServerConnection.Any, targetDomain: DomainId) {
      let alive = true
      let busy = false

      const run = () => {
        if (busy) return
        busy = true
        void check(conn)
          .then((next) => {
            if (!alive) return
            setState("healthyByDomain", targetDomain, next)
          })
          .finally(() => {
            busy = false
          })
      }

      run()
      const interval = setInterval(run, HEALTH_POLL_INTERVAL_MS)
      return () => {
        alive = false
        clearInterval(interval)
      }
    }

    function setActive(input: ServerConnection.Key) {
      trace("setActive", {
        from: state.active,
        to: input,
      })
      if (state.active !== input) setState("active", input)
    }

    function originFor(key: ServerConnection.Key) {
      const conn = (allServers() ?? []).find((item) => ServerConnection.key(item) === key)
      if (isExtraAgentIntegration(conn?.integration)) return conn.integration
      return projectsKey(key)
    }

    function add(input: ServerConnection.Http) {
      const url_ = normalizeServerUrl(input.http.url)
      if (!url_) return
      const conn = { ...input, http: { ...input.http, url: url_ } }
      return batch(() => {
        const list = storedList()
        const existing = list.findIndex((x) => url(x) === url_)
        if (existing !== -1) {
          setStore("list", existing, conn)
        } else {
          setStore("list", list.length, conn)
        }
        setState("active", ServerConnection.key(conn))
        return conn
      })
    }

    function remove(key: ServerConnection.Key) {
      const list = storedList().filter((x) => url(x) !== key)
      batch(() => {
        setStore("list", list)
        if (state.active === key) {
          const next = list[0]
          setState("active", next ? ServerConnection.Key.make(url(next)) : props.defaultServer)
        }
      })
    }

    const isReady = createMemo(() => ready() && !!state.active)

    const check = (conn: ServerConnection.Any) => checkServerHealth(conn.http).then((x) => x.healthy)

    const current: Accessor<ServerConnection.Any | undefined> = createMemo(() => {
      const servers = allServers() ?? []
      return servers.find((s) => ServerConnection.key(s) === state.active) ?? servers[0]
    })
    const domain = createMemo(() => domainFromIntegration(current()?.integration))

    const polls = new Map<ServerConnection.Key, { url: string; domain: DomainId; stop: () => void }>()

    createEffect(() => {
      const legacy = store.currentSidecarUrl
      if (!legacy) return
      setStore("list", (list) =>
        list.filter((value) => {
          const next = typeof value === "string" ? value : "type" in value ? value.http.url : value.url
          return next !== legacy
        }),
      )
      setStore("currentSidecarUrl", undefined)
    })

    createEffect(() => {
      const servers = allServers() ?? []
      const byKey = new Map<ServerConnection.Key, { conn: ServerConnection.Any; domain: DomainId }>()
      for (const conn of servers) {
        const key = ServerConnection.key(conn)
        byKey.set(key, { conn, domain: domainFromIntegration(conn.integration) })
      }

      for (const [key, { conn, domain: d }] of byKey) {
        const existing = polls.get(key)
        if (existing?.url === conn.http.url && existing.domain === d) continue
        existing?.stop()
        setState("healthyByDomain", d, undefined)
        const stop = startHealthPolling(conn, d)
        polls.set(key, { url: conn.http.url, domain: d, stop })
      }

      for (const [key, poll] of Array.from(polls.entries())) {
        if (byKey.has(key)) continue
        poll.stop()
        polls.delete(key)
      }

      const domainsAlive = new Set<DomainId>()
      for (const [, { domain: d }] of byKey) domainsAlive.add(d)
      const known = Object.keys(state.healthyByDomain) as DomainId[]
      const stale = known.filter((d) => !domainsAlive.has(d))
      if (stale.length > 0) {
        setState(
          "healthyByDomain",
          produce((draft) => {
            for (const d of stale) delete draft[d]
          }),
        )
      }
    })

    createEffect(() => {
      const current_ = current()
      if (!current_) return
      if (!isExtraAgentIntegration(current_.integration)) {
        setState("lastNonExtraAgent", ServerConnection.key(current_))
      }
    })

    // Keep state.active aligned with a real connection. current() falls back to
    // servers[0] when active is missing, but origin used to read state.active
    // directly — that split made projects.open write to mainOrigin while list()
    // read an empty stale bucket until reload.
    createEffect(() => {
      const servers = allServers() ?? []
      if (servers.length === 0) return
      const active = state.active
      if (servers.some((item) => ServerConnection.key(item) === active)) return
      const fallback = servers.find((item) => !isExtraAgentIntegration(item.integration)) ?? servers[0]
      if (!fallback) return
      const next = ServerConnection.key(fallback)
      console.debug(`[server] repair stale active=${String(active)} next=${next}`)
      setState("active", next)
    })

    onCleanup(() => {
      for (const poll of polls.values()) poll.stop()
      polls.clear()
    })

    const origin = createMemo(() => {
      const conn = current()
      return resolveProjectsListKey({
        active: state.active,
        currentKey: conn ? ServerConnection.key(conn) : undefined,
        currentIntegration: conn?.integration,
      })
    })
    const mainOrigin = () => {
      const last = state.lastNonExtraAgent
      if (last) return projectsKey(last)
      const fallback = allServers().find((item) => !isExtraAgentIntegration(item.integration))
      if (fallback) return originFor(ServerConnection.key(fallback))
      return projectsKey(state.active)
    }
    const persistOrigin = (directory?: string) => {
      const agent = extraAgentByDirectory(directory)
      if (agent) return agent.id
      // Ordinary projects always persist on the main OpenCode bucket, even when
      // the UI is temporarily browsing an extra-agent domain.
      return mainOrigin()
    }
    const [pendingOpens, setPendingOpens] = createSignal<string[]>([])
    const projectsList = createMemo(() => storedProjects()[origin()] ?? [])
    const projectsFor = (input?: ServerConnection.Key) => {
      const key = input ? originFor(input) : origin()
      if (!key) return [] as StoredProject[]
      return storedProjects()[key] ?? []
    }
    const hasWorktree = (items: StoredProject[], directory: string) =>
      items.some((item) => sameWorkspacePath(item.worktree, directory))
    const removeWorktree = (items: StoredProject[], directory: string) => {
      const next = items.filter((item) => !sameWorkspacePath(item.worktree, directory))
      return { next, removed: items.length - next.length }
    }
    const writeProject = (directory: string, key = persistOrigin(directory)) => {
      if (!key) {
        console.debug(`[project-open] skip empty-key directory=${directory}`)
        return false
      }
      const live = origin()
      const main = mainOrigin()
      if (live && live !== key) {
        console.debug(
          `[project-open] key-mismatch write=${key} live=${live} main=${main} domain=${domain()} directory=${directory}`,
        )
      }
      const current = storedProjects()[key] ?? []
      if (hasWorktree(current, directory)) {
        console.debug(`[project-open] skip duplicate key=${key} directory=${directory} count=${current.length}`)
        return false
      }
      console.debug(
        `[project-open] write key=${key} live=${live} main=${main} directory=${directory} count=${current.length} ready=${ready()}`,
      )
      setStore("projects", key, [{ worktree: directory, expanded: true }, ...current])
      // If list() is still pointed at a different bucket (should be rare after
      // origin/active repair), mirror so the rail updates without a reload.
      if (live && live !== key && domain() === mainDomain) {
        const visible = storedProjects()[live] ?? []
        if (!hasWorktree(visible, directory)) {
          console.debug(`[project-open] mirror write live=${live} from=${key} directory=${directory}`)
          setStore("projects", live, [{ worktree: directory, expanded: true }, ...visible])
        }
      }
      return true
    }
    const closeProjectInStore = (directory: string) => {
      const keys = new Set<string>()
      const live = origin()
      const main = mainOrigin()
      if (live) keys.add(live)
      if (main) keys.add(main)
      // Also scrub any bucket that still holds an alias (stale origin mirrors).
      for (const [bucket, items] of Object.entries(storedProjects())) {
        if (items.some((item) => sameWorkspacePath(item.worktree, directory))) keys.add(bucket)
      }
      let removed = 0
      for (const key of keys) {
        const current = storedProjects()[key] ?? []
        const result = removeWorktree(current, directory)
        if (result.removed === 0) continue
        removed += result.removed
        console.debug(
          `[project-close] store key=${key} directory=${directory} removed=${result.removed} left=${result.next.length}`,
        )
        setStore("projects", key, result.next)
      }
      if (removed === 0) {
        console.debug(
          `[project-close] store miss directory=${directory} aliases=${workspacePathAliases(directory).join("|")} keys=${[...keys].join("|")}`,
        )
      }
      return removed
    }
    createEffect(() => {
      if (!ready()) return
      const queued = pendingOpens()
      if (queued.length === 0) return
      setPendingOpens([])
      console.debug(`[project-open] flush queued=${queued.length}`)
      for (const directory of queued) writeProject(directory)
    })
    const isLocal = createMemo(() => {
      const c = current()
      return (c?.type === "sidecar" && c.variant === "base") || (c?.type === "http" && isLocalHost(c.http.url))
    })

    return {
      ready: isReady,
      healthy,
      healthyFor,
      isLocal,
      get key() {
        return state.active
      },
      get name() {
        return serverName(current())
      },
      get list() {
        return allServers()
      },
      get current() {
        return current()
      },
      get domain() {
        return domain()
      },
      domainFor(input?: ServerConnection.Key) {
        const conn = input ? allServers().find((item) => ServerConnection.key(item) === input) : current()
        return domainFromIntegration(conn?.integration)
      },
      currentFor(input: DomainId) {
        if (input === domain()) return current()
        if (input === mainDomain) return allServers().find((item) => !isExtraAgentIntegration(item.integration))
        const id = input.slice("extra-agent/".length)
        return allServers().find((item) => item.integration === id)
      },
      get lastNonExtraAgent() {
        const key = state.lastNonExtraAgent
        const conn = allServers().find((item) => ServerConnection.key(item) === key)
        if (!isExtraAgentIntegration(conn?.integration)) return key
        const fallback = allServers().find((item) => !isExtraAgentIntegration(item.integration))
        if (!fallback) return
        return ServerConnection.key(fallback)
      },
      lastFor(input: DomainId) {
        if (input === mainDomain) return this.lastNonExtraAgent
        const id = input.slice("extra-agent/".length)
        const conn = allServers().find((item) => item.integration === id)
        if (!conn) return
        return ServerConnection.key(conn)
      },
      setActive,
      add,
      remove,
      projects: {
        list: projectsList,
        listFor(input?: ServerConnection.Key) {
          return projectsFor(input)
        },
        open(directory: string) {
          if (!ready()) {
            setPendingOpens((prev) => {
              if (prev.some((item) => workspaceKey(item) === workspaceKey(directory))) return prev
              console.debug(`[project-open] queue directory=${directory} pending=${prev.length + 1}`)
              return [...prev, directory]
            })
            return
          }
          writeProject(directory)
        },
        openFor(input: ServerConnection.Key | undefined, directory: string) {
          const key = input ? originFor(input) : persistOrigin(directory)
          writeProject(directory, key)
        },
        close(directory: string) {
          closeProjectInStore(directory)
        },
        closeFor(input: ServerConnection.Key | undefined, directory: string) {
          const key = input ? originFor(input) : origin()
          if (!key) {
            closeProjectInStore(directory)
            return
          }
          const current = projectsFor(input)
          const result = removeWorktree(current, directory)
          console.debug(
            `[project-close] store-for key=${key} directory=${directory} removed=${result.removed} left=${result.next.length}`,
          )
          setStore("projects", key, result.next)
          // Also scrub aliases from other buckets so mirrored opens cannot resurrect.
          closeProjectInStore(directory)
        },
        expand(directory: string) {
          const key = origin()
          if (!key) return
          const current = projectsFor()
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        expandFor(input: ServerConnection.Key | undefined, directory: string) {
          const key = input ? originFor(input) : origin()
          if (!key) return
          const current = projectsFor(input)
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", true)
        },
        collapse(directory: string) {
          const key = origin()
          if (!key) return
          const current = projectsFor()
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        collapseFor(input: ServerConnection.Key | undefined, directory: string) {
          const key = input ? originFor(input) : origin()
          if (!key) return
          const current = projectsFor(input)
          const index = current.findIndex((x) => x.worktree === directory)
          if (index !== -1) setStore("projects", key, index, "expanded", false)
        },
        move(directory: string, target: string) {
          const key = origin()
          if (!key) return
          const current = projectsFor()
          // IMPORTANT: current is the full persisted order, which may include
          // hidden pseudo projects (for example extra-agent entries). Dragging
          // in the rail happens against a filtered visible list, so this layer
          // must resolve the visible target project ID back into the real array
          // slot. Do not accept a filtered index here, or visible reorders will
          // drift whenever hidden entries are present in current.
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          const toIndex = current.findIndex((x) => x.worktree === target)
          if (fromIndex === -1 || fromIndex === toIndex) return
          console.debug(
            `[project-dnd] move request directory=${directory} target=${target} from=${fromIndex} to=${toIndex} order=${current.map((item) => item.worktree).join(" | ")}`,
          )
          if (toIndex === -1) {
            console.debug(`[project-dnd] move target-missing directory=${directory} target=${target}`)
            return
          }
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          console.debug(`[project-dnd] move applied order=${result.map((item) => item.worktree).join(" | ")}`)
          setStore("projects", key, result)
        },
        moveFor(input: ServerConnection.Key | undefined, directory: string, toIndex: number) {
          const key = input ? originFor(input) : origin()
          if (!key) return
          const current = projectsFor(input)
          const fromIndex = current.findIndex((x) => x.worktree === directory)
          if (fromIndex === -1 || fromIndex === toIndex) return
          const result = [...current]
          const [item] = result.splice(fromIndex, 1)
          result.splice(toIndex, 0, item)
          setStore("projects", key, result)
        },
        last() {
          const key = origin()
          if (!key) return
          return storedLastProject()[key]
        },
        lastFor(input: ServerConnection.Key) {
          const key = originFor(input)
          if (!key) return
          return storedLastProject()[key]
        },
        touch(directory: string) {
          const key = origin()
          if (!key) return
          trace("projects.touch", {
            key,
            directory,
          })
          setStore("lastProject", key, directory)
        },
        touchFor(input: ServerConnection.Key | undefined, directory: string) {
          const key = input ? originFor(input) : origin()
          if (!key) return
          setStore("lastProject", key, directory)
        },
      },
    }
  },
})
