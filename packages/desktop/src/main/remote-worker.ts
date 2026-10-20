import * as http from "node:http"
import * as tls from "node:tls"
import { createRemoteGateway, type RemoteAuthSnapshot } from "./remote/gateway"
import { createOpenTunnelTransport, type TunnelStore, type TunnelStoreSnapshot } from "./remote/transport"

type Port = {
  on(event: "message", listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}
const parentPort = process.parentPort as Port | undefined
if (!parentPort) throw new Error("Remote worker requires an Electron utility process")
configureNetworkRuntime()

type StartInput = {
  type: "request"
  id: string
  method: "start"
  input: {
    generation: number
    upstream: { url: string; username: string; password: string }
    webRoot: string
    auth: RemoteAuthSnapshot
    tunnelStore: TunnelStoreSnapshot
  }
}
type Request = { type: "request"; id: string; method: string; input?: any }
let gateway: Awaited<ReturnType<typeof createRemoteGateway>> | undefined
let transport: Awaited<ReturnType<typeof createOpenTunnelTransport>> | undefined
let connection: Awaited<ReturnType<Awaited<ReturnType<typeof createOpenTunnelTransport>>["connect"]>> | undefined
let controller: AbortController | undefined
let upstream: StartInput["input"]["upstream"] | undefined
let tunnelSnapshot: TunnelStoreSnapshot = { version: 1, identities: {}, pending: {} }
let authSnapshot: RemoteAuthSnapshot = { version: 1, devices: [] }
let publicOrigin: string | undefined
let closing: Promise<void> | undefined
let activeGeneration = 0
let storeSequence = 0
const storeRequests = new Map<string, { resolve(): void; reject(error: Error): void }>()

parentPort.on("message", ({ data }) => {
  if (data && typeof data === "object" && (data as any).type === "store-result") {
    const pending = storeRequests.get((data as any).id)
    if (!pending) return
    storeRequests.delete((data as any).id)
    if ((data as any).ok === true) pending.resolve()
    else pending.reject(new Error("Remote secure persistence failed"))
    return
  }
  if (!data || typeof data !== "object" || (data as any).type !== "request") return
  const request = data as Request
  void dispatch(request).then(
    (result) => respond(request.id, true, result),
    (error) => {
      safeLog(`remote-worker request-failed method=${safeMethod(request.method)} code=${safeErrorCode(error)}`)
      respond(request.id, false, { error: "Remote access operation failed." })
    },
  )
})

async function dispatch(request: Request): Promise<unknown> {
  switch (request.method) {
    case "start":
      return start(request as StartInput)
    case "stop":
      await stop()
      return undefined
    case "pair":
      if (!gateway || !publicOrigin) throw new Error("Remote access is not online")
      return gateway.createPairing(publicOrigin)
    case "devices":
      return gateway?.devices() ?? []
    case "revoke":
      if (typeof request.input?.id !== "string" || request.input.id.length > 64) throw new Error("invalid-device")
      await gateway?.revoke(request.input.id)
      return undefined
    case "reset":
      await gateway?.reset()
      await removeTunnelIdentity()
      const previous = connection
      connection = undefined
      await previous?.close().catch(() => {})
      const oldTransport = transport
      transport = undefined
      await oldTransport?.dispose().catch(() => {})
      publicOrigin = undefined
      return undefined
    case "remove-identity":
      if (!isTunnelStoreInput(request.input?.tunnelStore)) throw new Error("invalid-tunnel-store")
      tunnelSnapshot = request.input.tunnelStore
      await removeTunnelIdentity()
      return undefined
    case "set-origin":
      if (typeof request.input?.origin !== "string" || request.input.origin.length > 256)
        throw new Error("invalid-origin")
      publicOrigin = request.input.origin
      gateway?.setPublicOrigin(publicOrigin)
      return undefined
    default:
      throw new Error("unsupported-operation")
  }
}

async function start(request: StartInput): Promise<{ url: string }> {
  const generation = Number(request.input.generation)
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("invalid-generation")
  activeGeneration = generation
  await teardown(generation)
  if (generation !== activeGeneration) throw new Error("start-cancelled")
  upstream = request.input.upstream
  authSnapshot = request.input.auth
  tunnelSnapshot = request.input.tunnelStore
  const authSave = async (snapshot: RemoteAuthSnapshot) => {
    authSnapshot = snapshot
    safeLog(`remote-worker store-write store=auth devices=${snapshot.devices.length}`)
    try {
      await saveInMain("auth", snapshot)
    } catch {
      safeLog("remote-worker operation-failed stage=secure-storage code=write-failed")
      throw secureStorageError()
    }
  }
  let stage = "gateway-startup"
  let candidateGateway: Awaited<ReturnType<typeof createRemoteGateway>> | undefined
  let candidateTransport: Awaited<ReturnType<typeof createOpenTunnelTransport>> | undefined
  let candidateController: AbortController | undefined
  let candidateConnection: NonNullable<typeof connection> | undefined
  let candidateOrigin: string | undefined
  try {
    safeLog("remote-worker gateway-create-started")
    candidateGateway = await createRemoteGateway({
      upstream: () => upstream,
      webRoot: request.input.webRoot,
      initialAuth: authSnapshot,
      saveAuth: authSave,
      log: (line) => parentPort?.postMessage({ type: "log", line }),
    })
    if (generation !== activeGeneration) throw new Error("start-cancelled")
    gateway = candidateGateway
    safeLog("remote-worker gateway-listening")
    stage = "sdk-initialization"
    candidateController = new AbortController()
    controller = candidateController
    safeLog("remote-worker sdk-initialization-started")
    candidateTransport = await createOpenTunnelTransport(tunnelStore(), {
      onProgress: (setupStage) => {
        if (generation !== activeGeneration || candidateController?.signal.aborted) return
        safeLog(`remote-worker setup-stage stage=${setupStage}`)
        notify("connecting", undefined, generation, setupStage)
      },
    })
    if (generation !== activeGeneration) throw new Error("start-cancelled")
    transport = candidateTransport
    safeLog("remote-worker sdk-initialized")
    stage = "tunnel-connect"
    notify("connecting", undefined, generation)
    safeLog("remote-worker tunnel-connect-started")
    candidateConnection = await candidateTransport.connect(
      candidateGateway.url.replace(/^http:\/\//, ""),
      candidateController.signal,
    )
    if (generation !== activeGeneration) throw new Error("start-cancelled")
    connection = candidateConnection
    candidateOrigin = `https://${candidateConnection.tunnel.hostname}`
    publicOrigin = candidateOrigin
    candidateGateway.setPublicOrigin(publicOrigin)
    safeLog("remote-worker tunnel-connected")
    notify("online", publicOrigin, generation)
    void monitor(connection, generation)
    void connection.closed
      .then(() => {
        if (generation === activeGeneration && connection === candidateConnection)
          notify("error", undefined, generation)
      })
      .catch(() => {
        if (generation === activeGeneration && connection === candidateConnection)
          notify("error", undefined, generation)
      })
    return { url: publicOrigin }
  } catch (error) {
    safeLog(`remote-worker operation-failed stage=${stage} code=${safeErrorCode(error)}`)
    if (generation === activeGeneration) {
      await teardown(generation)
    } else {
      candidateController?.abort()
      await candidateConnection?.close().catch(() => {})
      if (connection === candidateConnection) connection = undefined
      if (controller === candidateController) controller = undefined
      if (transport === candidateTransport) transport = undefined
      await candidateTransport?.dispose().catch(() => {})
      if (gateway === candidateGateway) gateway = undefined
      await candidateGateway?.close().catch(() => {})
      if (publicOrigin === candidateOrigin) publicOrigin = undefined
    }
    throw error
  }
}

async function monitor(current: NonNullable<typeof connection>, generation: number) {
  try {
    for await (const event of current.events) {
      if (generation !== activeGeneration || current !== connection) return
      const kind = String(event.type ?? event._tag ?? "")
      if (["connecting", "connected", "disconnected", "reconnecting", "stopped"].includes(kind))
        safeLog(`remote-worker tunnel-event type=${kind}`)
      if (kind === "reconnecting" || kind === "disconnected") notify("reconnecting", publicOrigin, generation)
      else if (kind === "connected") notify("online", publicOrigin, generation)
    }
  } catch {
    if (generation === activeGeneration && current === connection) notify("reconnecting", publicOrigin, generation)
  }
}

function stop(): Promise<void> {
  if (closing) return closing
  const generation = ++activeGeneration
  closing = (async () => {
    notify("stopping", undefined, generation)
    await teardown(generation)
    notify("disabled", undefined, generation)
  })().finally(() => {
    closing = undefined
  })
  return closing
}

async function teardown(generation: number) {
  controller?.abort()
  controller = undefined
  const current = connection
  connection = undefined
  await current?.close().catch(() => {})
  const oldGateway = gateway
  gateway = undefined
  await oldGateway?.close().catch(() => {})
  const oldTransport = transport
  transport = undefined
  await oldTransport?.dispose().catch(() => {})
  publicOrigin = undefined
  upstream = undefined
  for (const pending of storeRequests.values()) pending.reject(new Error("Remote worker stopped"))
  storeRequests.clear()
  if (generation !== activeGeneration) return
}

function notify(phase: string, url?: string, generation = activeGeneration, stage?: string) {
  parentPort?.postMessage({ type: "status", generation, phase, ...(url ? { url } : {}), ...(stage ? { stage } : {}) })
}

function respond(id: string, ok: boolean, value?: unknown) {
  parentPort?.postMessage({ type: "response", id, ok, ...(ok ? { value } : { error: value }) })
}

function saveInMain(store: "auth" | "tunnel", value: unknown): Promise<void> {
  const id = `store-${++storeSequence}`
  return new Promise<void>((resolve, reject) => {
    storeRequests.set(id, { resolve, reject })
    parentPort?.postMessage({ type: "store-write", id, store, value })
  })
}

function tunnelStore(): TunnelStore {
  return {
    load: async () => tunnelSnapshot,
    save: async (snapshot) => {
      tunnelSnapshot = snapshot
      safeLog(
        `remote-worker store-write store=tunnel identities=${Object.keys(snapshot.identities).length} pending=${Object.keys(snapshot.pending).length}`,
      )
      try {
        await saveInMain("tunnel", snapshot)
      } catch {
        safeLog("remote-worker operation-failed stage=secure-storage code=write-failed")
        throw secureStorageError()
      }
    },
  }
}

async function removeTunnelIdentity() {
  if (!transport) transport = await createOpenTunnelTransport(tunnelStore())
  safeLog("remote-worker tunnel-identity-remove-started")
  await transport.remove()
  safeLog("remote-worker tunnel-identity-removed")
}

function isTunnelStoreInput(value: unknown): value is TunnelStoreSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as any).version === 1 &&
      (value as any).identities &&
      typeof (value as any).identities === "object" &&
      (value as any).pending &&
      typeof (value as any).pending === "object",
  )
}

function safeLog(line: string) {
  parentPort?.postMessage({ type: "log", line })
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown"
  const candidate = error as { code?: unknown; _tag?: unknown; name?: unknown }
  for (const value of [candidate.code, candidate._tag, candidate.name]) {
    if (typeof value === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(value)) return value
  }
  return "unknown"
}

function safeMethod(value: string): string {
  return ["start", "stop", "pair", "devices", "revoke", "reset", "set-origin", "remove-identity"].includes(value)
    ? value
    : "unknown"
}

function secureStorageError() {
  return Object.assign(new Error("Remote access secure persistence failed"), { code: "REMOTE_SECURE_STORAGE" })
}

function configureNetworkRuntime() {
  const setCertificates = (tls as typeof tls & { setDefaultCACertificates?: (certs: string[]) => void })
    .setDefaultCACertificates
  const getCertificates = (tls as typeof tls & { getCACertificates?: (type: "default" | "system") => string[] })
    .getCACertificates
  try {
    if (setCertificates && getCertificates)
      setCertificates([...new Set([...getCertificates("default"), ...getCertificates("system")])])
  } catch {
    parentPort?.postMessage({ type: "log", line: "remote-worker system-certificates-unavailable" })
  }
  const proxy = Reflect.get(http, "setGlobalProxyFromEnv")
  if (typeof proxy === "function") {
    try {
      proxy.call(http)
    } catch {
      parentPort?.postMessage({ type: "log", line: "remote-worker env-proxy-setup-failed" })
    }
  }
  const loopback = ["127.0.0.1", "localhost", "::1"]
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const values = (process.env[key] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    for (const host of loopback) if (!values.some((item) => item.toLowerCase() === host)) values.push(host)
    process.env[key] = values.join(",")
  }
}
