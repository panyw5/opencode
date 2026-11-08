import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { Readable, Transform, Writable } from "node:stream"
import { StringDecoder } from "node:string_decoder"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AuthMethod,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import * as Log from "@opencode-ai/core/util/log"
import type { AcpConfig } from "./schema"

const log = Log.create({ service: "agent-backend.acp" })

export class AcpAuthenticationRequired extends Error {
  constructor(readonly methods: AuthMethod[]) {
    super("Authentication is required on the backend machine")
  }
}

export class AcpAgentClient {
  private child?: ChildProcessWithoutNullStreams
  private connection?: ClientSideConnection
  private stopping?: Promise<void>
  private stderr = ""
  private failure?: Error
  private exited = false
  private permissionAbort = new AbortController()
  sessionID?: string
  model?: string
  capabilities?: unknown
  authMethods: AuthMethod[] = []

  constructor(
    private readonly options: {
      config: AcpConfig
      cwd: string
      model?: string
      onEvent: (event: SessionNotification) => void
      requestPermission: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>
    },
  ) {}

  private async bounded<T>(work: () => Promise<T>, signal: AbortSignal, timeout: number): Promise<T> {
    if (signal.aborted) throw new Error("ACP operation aborted")
    if (this.failure) throw this.failure
    const operation = new AbortController()
    this.permissionAbort = operation
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = () => {}
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          abort = () => {
            operation.abort()
            void this.cancel().finally(() => this.stop())
            reject(new Error("ACP operation aborted"))
          }
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
          timer = setTimeout(() => {
            operation.abort()
            log.warn(`timeout session=${this.sessionID ?? "initializing"} ms=${timeout}`)
            void this.cancel().finally(() => this.stop())
            reject(new Error(`ACP operation timed out after ${timeout}ms`))
          }, timeout)
        }),
      ])
    } finally {
      operation.abort()
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    }
  }

  async start(signal: AbortSignal, options: { initializeOnly?: boolean; authMethod?: string } = {}) {
    if (signal.aborted) throw new Error("ACP startup aborted")
    if (this.child) throw new Error("ACP client already started")
    const [command, ...args] = this.options.config.command
    log.info(`spawn command=${command} argc=${args.length} cwd=${this.options.cwd}`)
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.config.env },
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
    })
    this.child = child
    child.on("error", (error) => {
      this.failure = new Error(`ACP process failed: ${error.message}`)
      log.warn(this.failure.message)
      child.stdout.destroy(this.failure)
    })
    child.stdin.on("error", (error) => {
      this.failure = new Error(`ACP stdin failed: ${error.message}`)
      log.warn(this.failure.message)
    })
    child.on("close", (code, signal) => {
      this.exited = true
      if (!this.stopping) this.failure = new Error(`ACP process exited code=${code} signal=${signal}: ${this.stderr}`)
      log.info(`exit pid=${child.pid} code=${code} signal=${signal} stopping=${!!this.stopping}`)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8000)
      log.debug(`stderr pid=${child.pid} text=${chunk.toString("utf8").slice(0, 1000)}`)
    })
    const decoder = new StringDecoder("utf8")
    let buffered = ""
    const frames = new Transform({
      transform: (chunk: Buffer, _encoding, done) => {
        try {
          buffered += decoder.write(chunk)
          let end: number
          while ((end = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, end)
            buffered = buffered.slice(end + 1)
            if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("ACP record exceeds 16 MiB")
            if (line.trim()) JSON.parse(line)
          }
          if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) throw new Error("ACP record exceeds 16 MiB")
          done(null, chunk)
        } catch (error) {
          this.failure = new Error(`Invalid ACP output: ${String(error)}`)
          log.warn(this.failure.message)
          done(this.failure)
          void this.stop()
        }
      },
    })
    child.stdout.on("error", (error) => frames.destroy(error))
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (event) => {
          if (this.sessionID && event.sessionId !== this.sessionID) {
            log.warn(`ignored foreign session update session=${event.sessionId}`)
            return
          }
          log.debug(`update session=${event.sessionId} type=${event.update.sessionUpdate}`)
          this.options.onEvent(event)
        },
        requestPermission: (request) => this.options.requestPermission(request, this.permissionAbort.signal),
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout.pipe(frames)) as unknown as ReadableStream<Uint8Array>,
      ),
    )
    this.connection = connection
    try {
      await this.bounded(
        async () => {
          const init = await connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "opencode", version: InstallationVersion },
            // The agent owns its filesystem. Do not expose unrestricted host callbacks.
            clientCapabilities: {},
          })
          if (init.protocolVersion !== PROTOCOL_VERSION)
            throw new Error(`Unsupported ACP protocol version ${init.protocolVersion}`)
          this.capabilities = init.agentCapabilities
          this.authMethods = init.authMethods ?? []
          log.info(`initialized protocol=${init.protocolVersion} agent=${init.agentInfo?.name ?? "unknown"}`)
          if (options.initializeOnly) return
          if (options.authMethod) {
            const method = this.authMethods.find((method) => method.id === options.authMethod)
            if (!method) throw new Error("The requested authentication method is not advertised by this adapter")
            const kind = (method as { type?: string }).type
            if (kind && kind !== "agent")
              throw new Error(
                "This authentication method requires environment credentials or an interactive terminal on the backend machine. Complete it there, then test again.",
              )
            log.info(`authenticate method=${options.authMethod}`)
            await connection.authenticate({ methodId: options.authMethod })
          }
          const session = await connection.newSession({ cwd: this.options.cwd, mcpServers: [] })
          this.sessionID = session.sessionId
          const select = async (category: "model" | "mode", value: string) => {
            const option = session.configOptions?.find((item) => item.category === category || item.id === category)
            if (!option || option.type !== "select") return false
            const values = option.options.flatMap((item) => ("options" in item ? item.options : [item]))
            if (!values.some((item) => item.value === value))
              throw new Error(`ACP agent does not advertise requested ${category} ${value}`)
            if (option.currentValue !== value)
              await connection.setSessionConfigOption({ sessionId: session.sessionId, configId: option.id, value })
            return true
          }
          const model = this.options.model ?? this.options.config.model
          if (model && !(await select("model", model))) {
            if (!session.models?.availableModels.some((item) => item.modelId === model))
              throw new Error(`ACP agent does not advertise requested model ${model}`)
            if (session.models.currentModelId !== model)
              await connection.unstable_setSessionModel({ sessionId: session.sessionId, modelId: model })
          }
          const modelOption = session.configOptions?.find((item) => item.category === "model" && item.type === "select")
          this.model =
            model ??
            session.models?.currentModelId ??
            (typeof modelOption?.currentValue === "string" ? modelOption.currentValue : undefined)
          const mode = this.options.config.mode
          if (mode && !(await select("mode", mode))) {
            if (!session.modes?.availableModes.some((item) => item.id === mode))
              throw new Error(`ACP agent does not advertise requested mode ${mode}`)
            if (session.modes.currentModeId !== mode)
              await connection.setSessionMode({ sessionId: session.sessionId, modeId: mode })
          }
          log.info(`ready session=${this.sessionID} model=${this.model ?? "default"}`)
        },
        signal,
        options.authMethod ? 300000 : 30000,
      )
    } catch (error) {
      await this.stop()
      if (error instanceof RequestError && error.code === -32000) throw new AcpAuthenticationRequired(this.authMethods)
      throw new Error(`ACP startup failed: ${String(error)}${this.stderr ? `; stderr: ${this.stderr}` : ""}`)
    }
  }

  async prompt(message: string, signal: AbortSignal, timeout: number) {
    const connection = this.connection
    const sessionId = this.sessionID
    if (!connection || !sessionId) throw new Error("ACP client is not ready")
    log.info(`prompt session=${sessionId} chars=${message.length}`)
    const result = await this.bounded(
      () =>
        connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: message }],
        }),
      signal,
      timeout,
    ).catch((error) => {
      throw this.failure ?? error
    })
    log.info(`completed session=${sessionId} reason=${result.stopReason}`)
    if (result.stopReason !== "end_turn") throw new Error(`ACP turn stopped: ${result.stopReason}`)
  }

  async cancel() {
    log.info(`cancel session=${this.sessionID ?? "initializing"}`)
    if (this.connection && this.sessionID)
      await Promise.race([
        this.connection.cancel({ sessionId: this.sessionID }).catch(() => {}),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250)
          timer.unref()
        }),
      ])
  }

  stop(): Promise<void> {
    this.permissionAbort.abort()
    if (this.stopping) return this.stopping
    const child = this.child
    if (!child || this.exited) return Promise.resolve()
    this.stopping = new Promise<void>((resolve) => {
      log.info(`stop pid=${child.pid} session=${this.sessionID ?? "initializing"}`)
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal)
          else child.kill(signal)
        } catch {}
      }
      const timer = setTimeout(() => {
        kill("SIGKILL")
      }, 1000)
      child.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
      kill("SIGTERM")
    })
    return this.stopping
  }
}
