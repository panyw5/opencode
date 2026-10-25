import * as http from "node:http"
import * as tls from "node:tls"
import { Effect, Layer } from "effect"
import type { SqliteMigrationProgress } from "../preload/types"

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  needsMigration: boolean
}

type StopCommand = { type: "stop" }

/**
 * Managed local-archive extension operation, driven by the desktop main
 * process (drag-and-drop install). Runs the same installation service as
 * the CLI inside this server process; the HTTP API stays CLI-only for
 * local paths. The digest is re-verified by the installation service.
 */
type ExtensionArchiveCommand = {
  type: "extension-archive"
  id: string
  op: "prepare" | "commit" | "status" | "cancel" | "cleanup-retained"
  payload: Record<string, unknown>
}

type SidecarCommand = StartCommand | StopCommand | ExtensionArchiveCommand

type SidecarMessage =
  | { type: "sqlite"; progress: SqliteMigrationProgress }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }
  | {
      type: "extension-archive-result"
      id: string
      ok: boolean
      value?: unknown
      error?: { code?: string; message: string }
    }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()
let listener: Listener | undefined
let fatalReported = false

// A stray unhandled rejection (e.g. ENOENT from a deleted project directory) must not
// take down the whole sidecar; log it and keep serving. Only uncaughtException is fatal.
process.on("unhandledRejection", (error) => {
  reportNonFatal("unhandledRejection", error)
})

process.on("uncaughtException", (error) => {
  reportFatal("uncaughtException", error)
})

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  if (command.type === "extension-archive") {
    void extensionArchive(command)
    return
  }
  void start(command)
})

type InstallRequestLike = {
  kind: string
  source?: unknown
  id?: string
  version?: string
  target?: string
  purgeData?: boolean
}

/**
 * Runs one managed-installation operation in-process. Mirrors the HTTP
 * adapter's mapping so both surfaces report the same failure codes.
 */
async function extensionArchive(command: Extract<SidecarCommand, { type: "extension-archive" }>) {
  const reply = (ok: boolean, value?: unknown, error?: { code?: string; message: string }) =>
    parentPort.postMessage({ type: "extension-archive-result", id: command.id, ok, value, error })
  try {
    const { installation } = await import("virtual:opencode-server")
    const installer = installation() as {
      prepare(request: InstallRequestLike): Promise<Record<string, unknown>>
      commit(operationId: string, token: string, input?: Record<string, unknown>): Promise<unknown>
      status(operationId: string, token: string): Promise<unknown>
      cancel(operationId: string, token?: string): Promise<unknown>
    }
    const payload = command.payload as {
      request?: InstallRequestLike
      operationId?: string
      token?: string
      input?: Record<string, unknown>
      extensionID?: string
      sha256?: string
    }
    if (command.op === "prepare") {
      if (!payload.request) return reply(false, undefined, { code: "invalid", message: "missing request" })
      const prepared = await installer.prepare(payload.request)
      reply(true, prepared)
      return
    }
    if (command.op === "cleanup-retained") {
      // Consumes a retained tombstone left behind by a deferred uninstall when
      // the newly requested archive is byte-identical (same sha256). Anything
      // else is a no-op so source-identity protections stay in charge.
      if (typeof payload.extensionID !== "string" || typeof payload.sha256 !== "string") {
        return reply(false, undefined, { code: "invalid", message: "extensionID and sha256 are required" })
      }
      try {
        const { ExtensionRegistry, purgeRetainedData } = await import("virtual:opencode-server")
        const registryFile = ExtensionRegistry.registryFile()
        const state = await ExtensionRegistry.snapshot(payload.extensionID as never, registryFile)
        const retained = state.retained as
          | { source?: { type?: string; sha256?: string }; revision?: number }
          | undefined
        if (
          retained &&
          retained.source?.type === "archive" &&
          retained.source.sha256?.toLowerCase() === payload.sha256.toLowerCase()
        ) {
          const result = await purgeRetainedData(registryFile, payload.extensionID as never, retained.revision)
          reply(true, { cleanupPending: result.cleanupPending })
          return
        }
        reply(true, { cleanupPending: false, matched: false })
        return
      } catch (error) {
        reply(false, undefined, { message: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    const { operationId, token } = payload
    if (typeof operationId !== "string" || typeof token !== "string") {
      return reply(false, undefined, { code: "invalid", message: "missing operation credentials" })
    }
    if (command.op === "commit") {
      reply(true, await installer.commit(operationId, token, payload.input ?? {}))
      return
    }
    if (command.op === "status") {
      reply(true, await installer.status(operationId, token))
      return
    }
    reply(true, await installer.cancel(operationId, token))
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined
    reply(false, undefined, {
      code,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function start(command: StartCommand) {
  try {
    console.error(
      `sidecar lifecycle start pid=${String(process.pid)} port=${String(command.port)} migrate=${String(command.needsMigration)}`,
    )
    prepareSidecarEnv(command.password)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    const { Database, Log, Server } = await import("virtual:opencode-server")
    console.error(`sidecar lifecycle bundle-ready pid=${String(process.pid)}`)
    await Log.init({ level: "INFO" })

    if (command.needsMigration) {
      parentPort.postMessage({
        type: "sqlite",
        progress: { type: "InProgress", value: 15, message: "Preparing local database" },
      })
      parentPort.postMessage({
        type: "sqlite",
        progress: { type: "InProgress", value: 45, message: "Applying database migrations" },
      })
      await Effect.runPromise(Effect.scoped(Layer.build(Database.defaultLayer)))
      parentPort.postMessage({
        type: "sqlite",
        progress: { type: "InProgress", value: 85, message: "Finalizing database upgrade" },
      })
      parentPort.postMessage({ type: "sqlite", progress: { type: "Done", message: "All done" } })
    }

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "opencode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    console.error(`sidecar lifecycle listen-ready pid=${String(process.pid)} port=${String(command.port)}`)
    parentPort.postMessage({ type: "ready" })
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    console.error(`sidecar lifecycle stop-begin pid=${String(process.pid)} listener=${String(!!listener)}`)
    await listener?.stop()
  } finally {
    console.error(`sidecar lifecycle stop-settled pid=${String(process.pid)}`)
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string) {
  Object.assign(process.env, {
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_CHANNEL_DB: "true",
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    callSetGlobalProxyFromEnv(http)
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function callSetGlobalProxyFromEnv(nodeHttp: object) {
  // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
  const setGlobalProxyFromEnv: unknown = Reflect.get(nodeHttp, "setGlobalProxyFromEnv")
  if (typeof setGlobalProxyFromEnv !== "function") return
  setGlobalProxyFromEnv.call(nodeHttp)
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return undefined
  const command = value as Partial<StartCommand | StopCommand | ExtensionArchiveCommand>
  if (command.type === "extension-archive") {
    const archive = command as Partial<ExtensionArchiveCommand>
    if (
      typeof archive.id !== "string" ||
      (archive.op !== "prepare" && archive.op !== "commit" && archive.op !== "status" && archive.op !== "cancel")
    )
      return undefined
    if (!archive.payload || typeof archive.payload !== "object") return undefined
    return archive as ExtensionArchiveCommand
  }
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return undefined
  if (typeof command.hostname !== "string") return undefined
  if (typeof command.port !== "number") return undefined
  if (typeof command.password !== "string") return undefined
  if (typeof command.needsMigration !== "boolean") return undefined
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    needsMigration: command.needsMigration,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}

function reportFatal(type: "uncaughtException" | "unhandledRejection", error: unknown) {
  if (fatalReported) return
  fatalReported = true
  const serialized = serializeError(error)
  const message = `sidecar ${type}: ${serialized.stack ?? serialized.message}`
  const fatalError = serialized.stack ? { message, stack: serialized.stack } : { message }
  try {
    parentPort.postMessage({ type: "error", error: fatalError })
  } catch {
    // Preserve the fatal path even if the Electron message port is already gone.
  }
  console.error(message)
  setImmediate(() => process.exit(1))
}

function reportNonFatal(type: "unhandledRejection", error: unknown) {
  const serialized = serializeError(error)
  console.error(`sidecar ${type} (non-fatal, logged): ${serialized.stack ?? serialized.message}`)
}
