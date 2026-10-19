import { randomUUID } from "node:crypto"
import { app, safeStorage, utilityProcess } from "electron"
import { join } from "node:path"
import type { RemoteAccessStatus, RemoteDevice, RemotePairing } from "@opencode-ai/app/remote/types"
import type { RemoteAuthSnapshot } from "./gateway"
import { RemoteVault } from "./storage"
import type { TunnelStoreSnapshot } from "./transport"

type Persistence = { version: 1; auth: RemoteAuthSnapshot; tunnel: TunnelStoreSnapshot }
type WorkerMessage =
  | { type: "response"; id: string; ok: boolean; value?: unknown; error?: unknown }
  | { type: "status"; generation: number; phase: string; url?: string }
  | { type: "store-write"; id: string; store: "auth" | "tunnel"; value: unknown }
  | { type: "log"; line: string }
type WorkerProcess = {
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: "message", listener: (message: WorkerMessage) => void): unknown
  on(event: "exit", listener: (code: number) => void): unknown
  once(event: "exit", listener: (code: number) => void): unknown
  on(event: "error", listener: (error: unknown) => void): unknown
  postMessage(message: unknown): void
  kill(): void
}

export type RemoteAccessController = ReturnType<typeof createRemoteAccessController>
export function createRemoteAccessController(options: {
  workerPath: string
  webRoot: string
  getUpstream(): { url: string; username: string; password: string } | undefined
  getEnabled(): boolean
  setEnabled(enabled: boolean): void
  log(message: string): void
  fork?: (path: string) => WorkerProcess
  persist?: {
    read(): Promise<Persistence | undefined>
    write(value: Persistence): Promise<void>
    clear(): Promise<void>
  }
}) {
  const secure = {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  }
  const vault =
    options.persist ??
    new RemoteVault<Persistence>(
      join(app.getPath("userData"), "remote-access", "secrets.enc"),
      secure,
      options.log,
      isPersistence,
    )
  const empty: Persistence = {
    version: 1,
    auth: { version: 1, devices: [] },
    tunnel: { version: 1, identities: {}, pending: {} },
  }
  const listeners = new Set<(status: RemoteAccessStatus) => void>()
  const pending = new Map<
    string,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  const closingWorkers = new WeakSet<WorkerProcess>()
  let state: RemoteAccessStatus = {
    enabled: options.getEnabled(),
    phase: options.getEnabled() ? "reconnecting" : "disabled",
  }
  let child: WorkerProcess | undefined
  let workerGeneration = 0
  let data: Persistence | undefined
  let loading: Promise<Persistence> | undefined
  let startGeneration = 0
  let starting: { upstream: NonNullable<ReturnType<typeof options.getUpstream>>; promise: Promise<void> } | undefined
  let stopping: Promise<void> | undefined
  let lastUpstream: { url: string; username: string; password: string } | undefined
  let writes = Promise.resolve()
  let persistenceFailed = false
  let manuallyDisabled = false
  let resetting = false

  function enabled() {
    return options.getEnabled() && !persistenceFailed && !manuallyDisabled && !resetting
  }

  function emit(next: RemoteAccessStatus) {
    state = next
    for (const listener of listeners) listener({ ...state })
  }

  async function persistence(): Promise<Persistence> {
    if (data) return data
    if (loading) return loading
    loading = (async () => {
      try {
        data = (await vault.read()) ?? empty
        return data
      } catch (error) {
        options.log("remote-controller secure-persistence-load-failed")
        throw error
      }
    })().finally(() => {
      loading = undefined
    })
    return loading
  }

  function save(update: Partial<Persistence>) {
    writes = writes
      .catch(() => {})
      .then(async () => {
        const current = await persistence()
        data = { ...current, ...update }
        await vault.write(data)
      })
    return writes
  }

  function createWorker() {
    if (child) return child
    const fork =
      options.fork ??
      ((path) =>
        utilityProcess.fork(path, [], {
          env: remoteWorkerEnvironment(),
          serviceName: "opencode remote access",
          stdio: "pipe",
        }) as unknown as WorkerProcess)
    const worker = fork(options.workerPath)
    child = worker
    for (const [stream, name] of [
      [worker.stdout, "stdout"],
      [worker.stderr, "stderr"],
    ] as const) {
      stream?.on("data", (chunk) => {
        const size = Buffer.isBuffer(chunk) ? chunk.length : chunk.length
        if (size > 0)
          options.log(
            `remote-controller worker-output stream=${name} bytes=${Math.min(size, 1_000_000)} content=redacted`,
          )
      })
    }
    worker.on("message", (message) => {
      if (child !== worker) return
      if (!message || typeof message !== "object") return
      if (message.type === "response") {
        const operation = pending.get(message.id)
        if (!operation) return
        pending.delete(message.id)
        clearTimeout(operation.timer)
        if (message.ok) operation.resolve(message.value)
        else operation.reject(new Error("Remote access operation failed."))
      }
      if (message.type === "status") {
        if (message.generation !== workerGeneration) return
        const phase = normalizePhase(message.phase)
        const url = validPublicUrl(message.url) ? message.url : undefined
        emit({
          enabled: enabled(),
          phase,
          ...(url ? { url } : {}),
          ...(phase === "error" ? { error: "Remote access connection stopped." } : {}),
        })
      }
      if (message.type === "store-write") {
        const valid = message.store === "auth" ? isAuth(message.value) : isTunnelStore(message.value)
        if (!message.id || message.id.length > 128 || !valid) {
          worker.postMessage({ type: "store-result", id: message.id, ok: false })
          return
        }
        const update =
          message.store === "auth"
            ? { auth: message.value as RemoteAuthSnapshot }
            : { tunnel: message.value as TunnelStoreSnapshot }
        void save(update).then(
          () => {
            worker.postMessage({ type: "store-result", id: message.id, ok: true })
            if (message.store === "auth") emit({ ...state })
          },
          () => {
            options.log(`remote-controller ${message.store}-persistence-failed`)
            worker.postMessage({ type: "store-result", id: message.id, ok: false })
            failClosed()
          },
        )
      }
      if (
        message.type === "log" &&
        typeof message.line === "string" &&
        /^[a-z0-9-]+(?: [a-zA-Z0-9_.=-]+)*$/.test(message.line)
      )
        options.log(message.line)
    })
    worker.on("exit", () => {
      if (child !== worker) return
      child = undefined
      rejectPending()
      if (enabled() && !closingWorkers.has(worker))
        emit({ enabled: true, phase: "error", error: "Remote access worker stopped." })
    })
    worker.on("error", () => {
      if (child !== worker) return
      options.log("remote-controller worker-error")
      emit({ enabled: enabled(), phase: "error", error: "Remote access worker failed." })
    })
    return worker
  }

  function request<T>(method: string, input?: unknown): Promise<T> {
    const worker = child
    if (!worker) return Promise.reject(new Error("Remote access is unavailable."))
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = method === "stop" ? 2_000 : 30_000
      const timer = setTimeout(() => {
        const operation = pending.get(id)
        if (!operation) return
        pending.delete(id)
        operation.reject(new Error("Remote access operation timed out."))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      worker.postMessage({ type: "request", id, method, input })
    })
  }

  function rejectPending() {
    for (const operation of pending.values()) {
      clearTimeout(operation.timer)
      operation.reject(new Error("Remote access worker stopped."))
    }
    pending.clear()
  }

  function failClosed() {
    persistenceFailed = true
    try {
      options.setEnabled(false)
    } catch {
      options.log("remote-controller failed to persist disabled preference")
    }
    manuallyDisabled = true
    options.log("remote-controller secure persistence failed; remote access disabled")
    void stopWorker()
      .catch(() => {})
      .finally(() => {
        if (enabled() || child || !persistenceFailed) return
        emit({
          enabled: false,
          phase: "error",
          error: "Secure persistence failed. Remote access was disabled; retry after storage is restored.",
        })
      })
  }

  function sameUpstream(
    left: NonNullable<ReturnType<typeof options.getUpstream>>,
    right: NonNullable<ReturnType<typeof options.getUpstream>>,
  ) {
    return left.url === right.url && left.username === right.username && left.password === right.password
  }

  function start(upstream: NonNullable<ReturnType<typeof options.getUpstream>>): Promise<void> {
    if (starting && sameUpstream(starting.upstream, upstream)) return starting.promise
    const promise = startNow(upstream)
      .catch(() => {
        if (!enabled()) return
        options.log("remote-controller start-failed")
        emit({ enabled: true, phase: "error", error: "Remote access could not start." })
      })
      .finally(() => {
        if (starting?.promise === promise) starting = undefined
      })
    starting = { upstream, promise }
    return promise
  }

  async function startNow(upstream: NonNullable<ReturnType<typeof options.getUpstream>>) {
    const generation = ++startGeneration
    const persisted = await persistence()
    if (stopping) await stopping
    if (generation !== startGeneration || !enabled()) return
    const worker = createWorker()
    lastUpstream = upstream
    workerGeneration = generation
    emit({ enabled: true, phase: "starting" })
    const id = randomUUID()
    const started = new Promise<{ url: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const operation = pending.get(id)
        if (!operation) return
        pending.delete(id)
        operation.reject(new Error("Remote access startup timed out."))
      }, 5 * 60_000)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      worker.postMessage({
        type: "request",
        id,
        method: "start",
        input: { generation, upstream, webRoot: options.webRoot, auth: persisted.auth, tunnelStore: persisted.tunnel },
      })
    })
    try {
      const result = await started
      if (generation !== startGeneration || !enabled()) {
        await stopWorker()
        return
      }
      if (!validPublicUrl(result.url)) throw new Error("Invalid remote tunnel URL")
      emit({ enabled: true, phase: "online", url: result.url })
    } catch {
      if (generation === startGeneration && enabled()) {
        await stopWorker(false)
        if (generation === startGeneration && enabled())
          emit({ enabled: true, phase: "error", error: "Remote access could not start." })
      }
    }
  }

  async function stopWorker(cancelStarting = true) {
    if (stopping) return stopping
    if (cancelStarting) startGeneration += 1
    const worker = child
    if (!worker) {
      emit({ enabled: enabled(), phase: enabled() ? "reconnecting" : "disabled" })
      return
    }
    stopping = (async () => {
      workerGeneration = -1
      emit({ enabled: enabled(), phase: "stopping" })
      await request("stop").catch(() => {})
      closingWorkers.add(worker)
      const firstExit = waitForExit(worker, 1_500)
      worker.kill()
      if (!(await firstExit)) {
        worker.kill()
        await waitForExit(worker, 1_500)
      }
      if (child === worker) child = undefined
      rejectPending()
      await writes.catch(() => {})
      lastUpstream = undefined
      emit({ enabled: enabled(), phase: enabled() ? "reconnecting" : "disabled" })
    })().finally(() => {
      stopping = undefined
    })
    return stopping
  }

  return {
    status: () => ({ ...state }),
    subscribe(listener: (status: RemoteAccessStatus) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async setUpstream(upstream: ReturnType<typeof options.getUpstream>) {
      if (!enabled()) return
      if (!upstream) {
        lastUpstream = undefined
        await stopWorker()
        emit({ enabled: true, phase: "reconnecting" })
        return
      }
      if (child && lastUpstream && sameUpstream(lastUpstream, upstream) && state.phase !== "error") return
      await stopWorker()
      await start(upstream)
    },
    async enable() {
      if (resetting) return state
      if (
        !persistenceFailed &&
        enabled() &&
        child &&
        ["starting", "connecting", "online", "reconnecting"].includes(state.phase)
      )
        return state
      if (persistenceFailed) {
        try {
          await writes.catch(() => {})
          await vault.write(await persistence())
          persistenceFailed = false
        } catch {
          try {
            options.setEnabled(false)
          } catch {}
          emit({
            enabled: false,
            phase: "error",
            error: "Secure persistence is still unavailable. Remote access remains disabled.",
          })
          return state
        }
      }
      options.setEnabled(true)
      manuallyDisabled = false
      emit({ enabled: true, phase: "starting" })
      const upstream = options.getUpstream()
      if (!upstream) {
        emit({ enabled: true, phase: "reconnecting" })
        return state
      }
      void start(upstream)
      return state
    },
    async disable() {
      manuallyDisabled = true
      try {
        options.setEnabled(false)
      } catch {
        options.log("remote-controller failed to persist disabled preference")
      }
      await stopWorker()
      return state
    },
    async pair(): Promise<RemotePairing> {
      if (!enabled() || state.phase !== "online") throw new Error("Remote access is not online.")
      return request("pair")
    },
    async devices(): Promise<RemoteDevice[]> {
      if (child && state.phase === "online") return request("devices")
      return (await persistence()).auth.devices
        .filter((device) => device.expiresAt > Date.now())
        .map(({ tokenHash: _hash, ...device }) => ({ ...device }))
    },
    async revoke(id: string) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid device identifier.")
      if (child && state.phase === "online") return request("revoke", { id })
      const current = await persistence()
      await save({ auth: { ...current.auth, devices: current.auth.devices.filter((device) => device.id !== id) } })
    },
    async reset() {
      const upstream = lastUpstream ?? options.getUpstream()
      const wasEnabled = enabled()
      resetting = true
      let revokeFailed = false
      let persisted: Persistence | undefined
      try {
        if (child) {
          revokeFailed = await request("reset").then(
            () => false,
            () => true,
          )
        }
        await stopWorker()
        await writes.catch(() => {})
        try {
          persisted = await persistence()
        } catch {
          options.log("remote-controller reset could not read encrypted snapshot; local vault removal will continue")
        }
        if (!persisted) {
          manuallyDisabled = true
          try {
            options.setEnabled(false)
          } catch {
            options.log("remote-controller reset could not persist disabled preference")
          }
        } else if (!revokeFailed) {
          const hasTunnelIdentity =
            Object.keys(persisted.tunnel.identities).length > 0 || Object.keys(persisted.tunnel.pending).length > 0
          if (!child && hasTunnelIdentity) {
            createWorker()
            revokeFailed = await request("remove-identity", { tunnelStore: persisted.tunnel }).then(
              () => false,
              () => true,
            )
            await stopWorker()
            await writes.catch(() => {})
          }
        }
        if (revokeFailed && persisted) {
          manuallyDisabled = true
          try {
            options.setEnabled(false)
          } catch {
            options.log("remote-controller reset could not persist disabled preference")
          }
          const result = {
            enabled: false,
            phase: "error" as const,
            error: "The tunnel identity could not be revoked. Encrypted credentials were retained for retry.",
          }
          emit(result)
          throw new Error(result.error)
        }
        await vault.clear()
        data = empty
        loading = undefined
        persistenceFailed = false
        resetting = false
        if (!persisted) {
          emit({ enabled: false, phase: "disabled" })
          return state
        }
        if (wasEnabled && !manuallyDisabled && upstream) {
          await start(upstream)
          return state
        }
        emit({ enabled: enabled(), phase: enabled() ? "reconnecting" : "disabled" })
        return state
      } catch (error) {
        resetting = false
        if (
          error instanceof Error &&
          error.message === "The tunnel identity could not be revoked. Encrypted credentials were retained for retry."
        )
          throw error
        manuallyDisabled = true
        persistenceFailed = true
        try {
          options.setEnabled(false)
        } catch {
          options.log("remote-controller reset could not persist disabled preference")
        }
        emit({
          enabled: false,
          phase: "error",
          error: "Remote access could not be reset. It remains disabled until storage is restored.",
        })
        throw new Error("Remote access could not be reset. It remains disabled until storage is restored.")
      }
    },
    async close() {
      await stopWorker()
      child?.kill()
      child = undefined
    },
  }
}

function normalizePhase(phase: string): RemoteAccessStatus["phase"] {
  return ["disabled", "starting", "connecting", "online", "reconnecting", "error", "stopping"].includes(phase)
    ? (phase as RemoteAccessStatus["phase"])
    : "error"
}

function isAuth(value: unknown): value is RemoteAuthSnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as any
  return (
    snapshot.version === 1 &&
    Array.isArray(snapshot.devices) &&
    snapshot.devices.length <= 32 &&
    snapshot.devices.every(
      (device: any) =>
        device &&
        typeof device.id === "string" &&
        /^[a-f0-9]{32}$/.test(device.id) &&
        typeof device.name === "string" &&
        device.name.length <= 80 &&
        Number.isFinite(device.createdAt) &&
        Number.isFinite(device.lastSeenAt) &&
        Number.isFinite(device.expiresAt) &&
        typeof device.tokenHash === "string" &&
        /^[a-f0-9]{64}$/.test(device.tokenHash),
    )
  )
}

function isTunnelStore(value: unknown): value is TunnelStoreSnapshot {
  if (!value || typeof value !== "object") return false
  const snapshot = value as any
  if (snapshot.version !== 1 || !isObjectMap(snapshot.identities) || !isObjectMap(snapshot.pending)) return false
  if (
    [...Object.keys(snapshot.identities), ...Object.keys(snapshot.pending)].some(
      (profile) => profile !== "opencode-desktop-remote",
    )
  )
    return false
  const identities = Object.values(snapshot.identities)
  const pending = Object.values(snapshot.pending)
  return (
    identities.length <= 1 &&
    pending.length <= 1 &&
    identities.every(
      (item: any) =>
        item &&
        validTunnelField(item.id, 128) &&
        validTunnelField(item.hostname, 253) &&
        validTunnelField(item.token, 4096) &&
        validTunnelField(item.privateKey, 64_000) &&
        validTunnelField(item.certificate, 64_000) &&
        validTunnelField(item.chain, 64_000) &&
        typeof item.certificateExpiry === "string" &&
        Number.isFinite(Date.parse(item.certificateExpiry)),
    ) &&
    pending.every(
      (item: any) =>
        item &&
        validTunnelField(item.id, 128) &&
        validTunnelField(item.hostname, 253) &&
        validTunnelField(item.token, 4096) &&
        validTunnelField(item.privateKey, 64_000) &&
        validTunnelField(item.csr, 64_000),
    )
  )
}

function isPersistence(value: unknown): value is Persistence {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as any).version === 1 &&
      isAuth((value as any).auth) &&
      isTunnelStore((value as any).tunnel),
  )
}

function isObjectMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function validTunnelField(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max
}

function validPublicUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.origin === value
    )
  } catch {
    return false
  }
}

function waitForExit(worker: WorkerProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    worker.once("exit", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function remoteWorkerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: "1" }
  const loopback = ["127.0.0.1", "localhost", "::1"]
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const values = (env[key] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    for (const host of loopback) if (!values.some((item) => item.toLowerCase() === host)) values.push(host)
    env[key] = values.join(",")
  }
  return env
}
