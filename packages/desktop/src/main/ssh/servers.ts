import type {
  SshDirectoryEntry,
  SshHostProbe,
  SshJob,
  SshOpencodeCheck,
  SshServerConfig,
  SshServerItem,
  SshServerRuntime,
  SshServersEvent,
  SshServersState,
} from "../../preload/types"
import { SSH_SERVERS_KEY } from "../constants"
import { getStore } from "../store"
import {
  type RunSshOptions,
  installRemoteOpencode,
  listRemoteDirectory as execListRemoteDirectory,
  parseSshTarget,
  probeSshHost,
  readRemoteOpencodeVersion,
  resolveRemoteOpencode,
  summarize,
  validateRemoteDirectory as execValidateRemoteDirectory,
} from "./exec"
import type { SshSidecar } from "./sidecar"

type SpawnSidecar = (target: string) => Promise<SshSidecar>

type ControllerLogger = {
  log: (message: string, meta?: unknown) => void
  error: (message: string, meta?: unknown) => void
}

type SshServersControllerOptions = {
  logger?: ControllerLogger
  readServers?: () => SshServerConfig[]
  writeServers?: (servers: SshServerConfig[]) => void
  resolveOpencode?: (target: string, opts?: RunSshOptions) => Promise<string | null>
  readCommandVersion?: (target: string, path: string, opts?: RunSshOptions) => Promise<string | null>
  probeHost?: (target: string, opts?: RunSshOptions) => Promise<{ reachable: boolean; error: string | null }>
  installOpencode?: (
    target: string,
    version: string,
    opts?: RunSshOptions,
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>
}

export type SshServersController = ReturnType<typeof createSshServersController>

export function sshServerIdForTarget(target: string) {
  return `ssh:${target}`
}

export function sshServerIdsToStartOnInitialize(servers: SshServerConfig[]) {
  return servers.filter((server) => server.autoStart).map((server) => server.id)
}

export function sshServerIdToRestart(servers: SshServerItem[], target: string) {
  return servers.find((item) => item.config.target === target)?.config.id ?? null
}

export function expectRemoteOpencodeVersion(installed: string | null, expected: string, target = "host") {
  if (installed === expected) return
  throw new Error(
    `OpenCode update finished but ${target} still reports ${installed ?? "no version"}; expected ${expected}`,
  )
}

function defaultResolveOpencode(target: string, opts?: RunSshOptions) {
  return resolveRemoteOpencode(requireTarget(target), opts)
}

function defaultReadCommandVersion(target: string, path: string, opts?: RunSshOptions) {
  return readRemoteOpencodeVersion(requireTarget(target), path, opts)
}

function defaultProbeHost(target: string, opts?: RunSshOptions) {
  return probeSshHost(requireTarget(target), opts)
}

function defaultInstallOpencode(target: string, version: string, opts?: RunSshOptions) {
  return installRemoteOpencode(requireTarget(target), version, opts)
}

export function createSshServersController(
  appVersion: string,
  spawnSidecar: SpawnSidecar,
  options?: SshServersControllerOptions,
) {
  let state: SshServersState = initialState()
  const listeners = new Set<(event: SshServersEvent) => void>()
  const sidecars = new Map<string, SshSidecar>()
  const startAttempts = new Map<string, number>()
  let jobAbort: AbortController | undefined
  const logger = options?.logger
  const readServers = options?.readServers ?? readPersistedServers
  const writeServers = options?.writeServers ?? writePersistedServers
  const resolveOpencode = options?.resolveOpencode ?? defaultResolveOpencode
  const readCommandVersion = options?.readCommandVersion ?? defaultReadCommandVersion
  const probeHostFn = options?.probeHost ?? defaultProbeHost
  const installOpencodeFn = options?.installOpencode ?? defaultInstallOpencode

  const emit = () => {
    for (const listener of listeners) listener({ type: "state", state })
  }

  const setState = (next: Partial<SshServersState>) => {
    state = { ...state, ...next }
    emit()
  }

  const persistServers = (servers: SshServerConfig[]) => {
    writeServers(servers)
  }

  const updateServer = (id: string, update: (item: SshServerItem) => SshServerItem) => {
    const next = state.servers.map((item) => (item.config.id === id ? update(item) : item))
    setState({ servers: next })
  }

  const beginJob = (job: SshJob): AbortController => {
    jobAbort?.abort()
    const abort = new AbortController()
    jobAbort = abort
    setState({ job })
    return abort
  }

  const endJob = (abort: AbortController) => {
    if (jobAbort !== abort) return
    jobAbort = undefined
    setState({ job: null })
  }

  const refreshFromStore = () => {
    const persisted = readServers()
    const items: SshServerItem[] = persisted.map((config) => {
      const existing = state.servers.find((item) => item.config.id === config.id)
      return {
        config,
        runtime: existing?.runtime ?? { kind: "stopped" },
      }
    })
    setState({ servers: items })
  }

  const setRuntime = (id: string, runtime: SshServerRuntime) => {
    updateServer(id, (item) => ({ ...item, runtime }))
  }

  const setHostProbe = (target: string, probe: SshHostProbe) => {
    setState({ probes: { ...state.probes, [target]: probe } })
  }

  const setOpencodeCheck = (target: string, check: SshOpencodeCheck) => {
    setState({
      opencodeChecks: {
        ...state.opencodeChecks,
        [target]: check,
      },
    })
  }

  const hasServer = (id: string, target: string) => {
    return state.servers.some((item) => item.config.id === id && item.config.target === target)
  }

  const checkOpencode = async (target: string, opts?: RunSshOptions) => {
    const resolved = await resolveOpencode(target, opts)
    const version = resolved ? await readCommandVersion(target, resolved, opts) : null
    return opencodeCheck(target, resolved, version, appVersion)
  }

  const refreshOpencodeCheckFor = async (target: string, opts?: RunSshOptions) => {
    setOpencodeCheck(target, await checkOpencode(target, opts))
  }

  const refreshOpencodeChecks = async (opts?: RunSshOptions) => {
    await Promise.all(
      state.servers.map((item) =>
        checkOpencode(item.config.target, opts)
          .then((check) => {
            if (!hasServer(item.config.id, item.config.target)) return
            setOpencodeCheck(item.config.target, check)
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            logger?.error("ssh opencode check failed", {
              id: item.config.id,
              target: item.config.target,
              message,
            })
          }),
      ),
    )
  }

  const nextStartAttempt = (id: string) => {
    const next = (startAttempts.get(id) ?? 0) + 1
    startAttempts.set(id, next)
    return next
  }

  const invalidateStartAttempt = (id: string) => {
    startAttempts.set(id, (startAttempts.get(id) ?? 0) + 1)
  }

  const isCurrentStartAttempt = (id: string, attempt: number) => {
    return startAttempts.get(id) === attempt && state.servers.some((item) => item.config.id === id)
  }

  const startServer = async (id: string) => {
    const item = state.servers.find((x) => x.config.id === id)
    if (!item) return
    const attempt = nextStartAttempt(id)
    await stopServerInternal(id)
    if (!isCurrentStartAttempt(id, attempt)) return
    setRuntime(id, { kind: "starting" })
    logger?.log("ssh sidecar starting", { id, target: item.config.target })
    try {
      const probe = await probeHostFn(item.config.target)
      if (!probe.reachable) {
        throw new Error(probe.error ?? `Cannot connect to ${item.config.target}`)
      }
      if (!isCurrentStartAttempt(id, attempt)) return
      const sidecar = await spawnSidecar(item.config.target)
      if (!isCurrentStartAttempt(id, attempt)) {
        try {
          sidecar.listener.stop()
        } catch {
          // ignore stop errors for stale sidecars
        }
        return
      }
      sidecars.set(id, sidecar)
      setRuntime(id, {
        kind: "ready",
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })
      sidecar.listener.onExit((code, signal) => {
        if (sidecars.get(id) !== sidecar) return
        sidecars.delete(id)
        const message = `SSH server exited (code=${code ?? "null"} signal=${signal ?? "null"})`
        setRuntime(id, { kind: "failed", message })
        logger?.error("ssh sidecar exited", { id, target: item.config.target, code, signal })
      })
      logger?.log("ssh sidecar ready", { id, target: item.config.target, url: sidecar.url })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isCurrentStartAttempt(id, attempt)) return
      setRuntime(id, { kind: "failed", message })
      logger?.error("ssh sidecar failed to start", { id, target: item.config.target, message })
    }
  }

  const stopServerInternal = async (id: string) => {
    const existing = sidecars.get(id)
    if (!existing) return
    sidecars.delete(id)
    try {
      existing.listener.stop()
    } catch {
      // ignore stop errors
    }
  }

  const runJob = async <T>(job: SshJob, runner: (abort: AbortController) => Promise<T>) => {
    const abort = beginJob(job)
    try {
      const value = await runner(abort)
      endJob(abort)
      return value
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        endJob(abort)
        return undefined
      }
      const err = error instanceof Error ? error : new Error(String(error))
      endJob(abort)
      throw err
    }
  }

  return {
    getState() {
      return state
    },
    subscribe(listener: (event: SshServersEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async initialize() {
      refreshFromStore()
      void refreshOpencodeChecks()
      for (const id of sshServerIdsToStartOnInitialize(state.servers.map((item) => item.config))) void startServer(id)
    },

    async probeHost(target: string) {
      await runJob({ kind: "probe", target, startedAt: Date.now() }, async (abort) => {
        const result = await probeHostFn(target, { signal: abort.signal })
        setHostProbe(target, { target, reachable: result.reachable, error: result.error })
      })
    },

    async probeOpencode(target: string) {
      await runJob({ kind: "probe-opencode", target, startedAt: Date.now() }, async (abort) => {
        await refreshOpencodeCheckFor(target, { signal: abort.signal })
      })
    },

    async installOpencode(target: string) {
      await runJob({ kind: "install-opencode", target, startedAt: Date.now() }, async (abort) => {
        const result = await installOpencodeFn(target, appVersion, { signal: abort.signal })
        if (result.code !== 0) {
          throw new Error(summarize(result.stderr || result.stdout) || "OpenCode installation failed")
        }
        await refreshOpencodeCheckFor(target, { signal: abort.signal })
        expectRemoteOpencodeVersion(state.opencodeChecks[target]?.version ?? null, appVersion, target)
        const id = sshServerIdToRestart(state.servers, target)
        if (id) await startServer(id)
      })
    },

    async addServer(target: string, autoStart = true): Promise<SshServerConfig> {
      const normalized = requireTarget(target).raw
      const id = sshServerIdForTarget(normalized)
      if (state.servers.some((item) => item.config.id === id)) {
        throw new Error(`${normalized} is already added`)
      }
      const config: SshServerConfig = {
        id,
        target: normalized,
        autoStart,
      }
      persistServers([...readServers(), config])
      setState({
        servers: [...state.servers, { config, runtime: { kind: "starting" } }],
      })
      void startServer(id)
      return config
    },

    async removeServer(id: string) {
      const target = state.servers.find((item) => item.config.id === id)?.config.target
      invalidateStartAttempt(id)
      await stopServerInternal(id)
      const remaining = readServers().filter((item) => item.id !== id)
      persistServers(remaining)
      const probes = { ...state.probes }
      const opencodeChecks = { ...state.opencodeChecks }
      if (target) {
        delete probes[target]
        delete opencodeChecks[target]
      }
      setState({
        servers: state.servers.filter((item) => item.config.id !== id),
        probes,
        opencodeChecks,
      })
    },

    startServer,

    stopAll() {
      for (const item of state.servers) invalidateStartAttempt(item.config.id)
      for (const existing of sidecars.values()) {
        try {
          existing.listener.stop()
        } catch {
          // ignore
        }
      }
      sidecars.clear()
    },

    async listRemoteDirectory(target: string, path: string): Promise<SshDirectoryEntry[]> {
      const parsed = requireTarget(target)
      const entries = await execListRemoteDirectory(parsed, path)
      return entries.map((entry) => ({ path: entry.path, kind: entry.kind }))
    },

    async validateRemoteDirectory(target: string, path: string): Promise<string | null> {
      return execValidateRemoteDirectory(requireTarget(target), path)
    },
  }
}

function initialState(): SshServersState {
  return {
    probes: {},
    opencodeChecks: {},
    servers: [],
    job: null,
  }
}

function requireTarget(target: string) {
  const parsed = parseSshTarget(target)
  if (!parsed) throw new Error(`Invalid SSH target: ${target}`)
  return parsed
}

function opencodeCheck(
  target: string,
  resolvedPath: string | null,
  version: string | null,
  expectedVersion: string,
): SshOpencodeCheck {
  if (!resolvedPath) {
    return {
      target,
      resolvedPath: null,
      version: null,
      expectedVersion,
      matchesDesktop: null,
      error: "opencode is not installed on this host",
    }
  }
  if (!version) {
    return {
      target,
      resolvedPath,
      version: null,
      expectedVersion,
      matchesDesktop: null,
      error: "opencode is installed but could not run",
    }
  }
  return {
    target,
    resolvedPath,
    version,
    expectedVersion,
    matchesDesktop: version === expectedVersion,
    error: null,
  }
}

function readPersistedServers(): SshServerConfig[] {
  const store = getStore()
  const existing = store.get(SSH_SERVERS_KEY)
  if (existing && typeof existing === "object") {
    const record = existing as { servers?: unknown }
    const list = Array.isArray(record.servers) ? record.servers : []
    return list.flatMap(normalizePersistedServer)
  }
  return []
}

function writePersistedServers(servers: SshServerConfig[]) {
  getStore().set(SSH_SERVERS_KEY, { servers })
}

function normalizePersistedServer(value: unknown): SshServerConfig[] {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const target = typeof record.target === "string" && record.target.trim().length > 0 ? record.target.trim() : null
  if (!target) return []
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : sshServerIdForTarget(target)
  return [
    {
      id,
      target,
      autoStart: record.autoStart === undefined ? true : record.autoStart === true,
    },
  ]
}
