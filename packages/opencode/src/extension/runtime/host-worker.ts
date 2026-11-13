import { randomUUID } from "node:crypto"
import { Effect, Exit, Scope, type Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import type { ExtensionHooks, ManagedProcess } from "@opencode-ai/extension-kit/server"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { makeRuntime } from "@/effect/run-service"
import { resolveSelfArgv } from "@/math/spawn"
import { HostProcessError } from "../host-process/protocol"
import {
  HostProcessSupervisor,
  type SpawnInput,
  type StopResult,
  type SupervisorLimits,
  type Worker,
  type WorkerInfo,
} from "../host-process/supervisor"
import type { RootExit } from "../host-process/transport"
import type { Loaded } from "../manifest"
import type { Entry } from "./slot"
import { makeProcessScope } from "./process"

const log = Log.create({ service: "extension" })

/** The supervisor is process-wide state: one runtime, lazily built. */
const supervisorRuntime = makeRuntime(HostProcessSupervisor, HostProcessSupervisor.layer)

/** Module surface the worker reports after import+activate (`module.shape`). */
export type ModuleShape = {
  server: boolean
  rpc: string[]
  dispose: boolean
}

/** Descriptor for one instance-level RPC tool the worker declared. */
type ToolDescriptor = { name: string; description: string; parameters: unknown }

export type WorkerErrors = {
  aborted(method: string): Error
  notFound(method: string): Error
  rpc(code: string, message: string): Error
}

/**
 * Injected runtime boundary: everything slot/generation-owned stays in
 * `runtime/index.ts`, this module only drives the protocol. `available()`
 * fences every callback so a dead generation can never publish into a newer
 * slot state.
 */
export type HostWorkerDeps = {
  entry: Entry
  manifest: Loaded
  registry: string
  installation: string
  gen: number
  epoch: number
  dataDir: string
  cacheDir: string
  serverUrl?: URL
  available(): boolean
  emit(name: string, data: unknown, directory?: string): void
  /** Root exit observed; the supervisor restarts unless hooks say otherwise. */
  crashed(exit: RootExit): void
  /** A restarted worker completed hello/init/ready (never the first ready). */
  restarted(): void
  /** Restart budget exhausted; the runtime stays errored until retry. */
  exhausted(exit: RootExit | undefined): void
  runtimeError(phase: string, message: string): void
  errors: WorkerErrors
  limits(): Partial<SupervisorLimits>
  killGraceMs(): number
  /** Host→worker proc stream credit budget in bytes (design §3.3). */
  procCreditBytes(): number
  /** Per-request admission deadline for service/instance RPC (ms). */
  requestTimeoutMs(): number
}

export type HostWorker = {
  info(): WorkerInfo
  ready(): Promise<ModuleShape>
  /** Forward one service-level RPC; errors arrive normalized. */
  serviceRpc(method: string, input: unknown, ctx: { directory?: string; signal: AbortSignal }): Promise<unknown>
  /** Run `instance.start` and wrap the returned descriptors in proxy hooks. */
  instanceStart(input: PluginInput, signal: AbortSignal): Promise<ExtensionHooks>
  /** Push a resolved settings snapshot to worker-side listeners. */
  settingsChanged(values: Record<string, unknown>): void
  /** Graceful stop: drain → dispose → observed exit, or `unknown`. */
  stop(): Promise<StopResult>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`extension worker ${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.length ? value : undefined
}

/** A managed child registered for one worker generation's `host.spawn` call. */
type HostedProcess = {
  processId: string
  proc: ManagedProcess
  /** Shared stdout+stderr send credit, refilled by worker `proc.credit`. */
  credit: number
  /** One in-flight chunk per stream while the credit window is closed. */
  pendingOut?: Buffer
  pendingErr?: Buffer
  dead: boolean
}

/**
 * Spawn a supervised worker for one extension entry generation. The returned
 * handle proxies service/instance RPC, tool execution, settings updates and
 * lifecycle over the fd3/fd4 control channel; `stop()` is the only teardown
 * path and reports observed root exit (`rootExited`) or `unknown`.
 */
export async function spawnHostWorker(deps: HostWorkerDeps): Promise<HostWorker> {
  const id = deps.manifest.id
  const started = Date.now()
  const detail = (phase: string) => ({
    extension: id,
    runtime: "process" as const,
    phase,
    gen: deps.gen,
    epoch: deps.epoch,
    elapsedMs: Date.now() - started,
  })

  // A dedicated process scope per worker generation: children spawned through
  // the worker's host.spawn are host OS children, so disposal kills the whole
  // tree exactly like the inline backend does in-process.
  const startedAt = Date.now()
  const openScope = () =>
    makeProcessScope({
      extension: id,
      gen: deps.gen,
      epoch: deps.epoch,
      started: startedAt,
      available: deps.available,
      killGraceMs: deps.killGraceMs,
    })
  let scope = openScope()
  let scopeClosed = false
  const scopeDisposal = () => {
    if (scopeClosed) return
    scopeClosed = true
    const draining = scope.dispose()
    if (draining) {
      deps.entry.processKills.add(draining)
      const settled = () => deps.entry.processKills.delete(draining)
      void draining.then(settled, settled)
    }
    deps.entry.resources.delete(scopeDisposal)
  }
  deps.entry.resources.add(scopeDisposal)

  // Reverse-channel tool call contexts: `tool.execute` registers ctx so
  // worker notifications (`tool.metadata`) and reverse calls (`tool.ask`)
  // reach the real host callbacks for that invocation.
  const activeCalls = new Map<
    string,
    {
      metadata(input: { title?: string; metadata?: Record<string, unknown> }): unknown
      ask(input: unknown): Promise<unknown>
    }
  >()
  const processes = new Map<string, HostedProcess>()
  let shape: ModuleShape | undefined
  let stopped = false

  const hosted = (input: Record<string, unknown>) => {
    const processId = optionalString(input.processId)
    return processId ? processes.get(processId) : undefined
  }

  function attachStream(proc: HostedProcess, stream: "out" | "err", source: NodeJS.ReadableStream | null) {
    if (!source) return
    const key = stream === "out" ? "pendingOut" : "pendingErr"
    const method = stream === "out" ? "proc.stdout" : "proc.stderr"
    source.on("data", (chunk: Buffer) => {
      if (proc.dead || stopped) return
      if (proc.credit >= chunk.length) {
        proc.credit -= chunk.length
        worker.notify(method, { processId: proc.processId, data: chunk.toString("base64") })
        return
      }
      // Credit window closed: keep at most one pending chunk per stream and
      // pause so unread kernel pipe bytes apply real backpressure (§3.3).
      proc[key] = chunk
      proc.credit = 0
      ;(source as unknown as { pause(): void }).pause()
    })
    source.on("error", () => {})
  }

  function refillCredit(proc: HostedProcess, bytes: number) {
    proc.credit += bytes
    for (const [key, method, stream] of [
      ["pendingOut", "proc.stdout", proc.proc.stdout],
      ["pendingErr", "proc.stderr", proc.proc.stderr],
    ] as const) {
      const chunk = proc[key as "pendingOut" | "pendingErr"]
      if (!chunk) continue
      if (proc.credit < chunk.length) break
      proc.credit -= chunk.length
      proc[key as "pendingOut" | "pendingErr"] = undefined
      worker.notify(method, { processId: proc.processId, data: chunk.toString("base64") })
      ;(stream as unknown as { resume(): void } | null)?.resume()
    }
  }

  function spawnHosted(input: Record<string, unknown>): Schema.Json {
    const command = input.command
    if (typeof command !== "string" || !command.length)
      throw new HostProcessError({ code: "requestFailed", detail: "host.spawn command must be a non-empty string" })
    const args = Array.isArray(input.args) ? input.args.filter((a): a is string => typeof a === "string") : []
    const env =
      input.env && typeof input.env === "object" && !Array.isArray(input.env)
        ? Object.fromEntries(Object.entries(input.env).filter((e): e is [string, string] => typeof e[1] === "string"))
        : undefined
    const stdio = Array.isArray(input.stdio) ? (input.stdio as ("ignore" | "pipe" | "inherit")[]) : undefined
    const proc = scope.spawn(command, args, {
      ...(env ? { env } : {}),
      ...(optionalString(input.cwd) ? { cwd: optionalString(input.cwd) } : {}),
      ...(stdio ? { stdio: [stdio[0] ?? "ignore", stdio[1] ?? "pipe", stdio[2] ?? "pipe"] } : {}),
    })
    const processId = randomUUID()
    const registration: HostedProcess = { processId, proc, credit: deps.procCreditBytes(), dead: false }
    processes.set(processId, registration)
    attachStream(registration, "out", proc.stdout as NodeJS.ReadableStream | null)
    attachStream(registration, "err", proc.stderr as NodeJS.ReadableStream | null)
    proc.onExit((code, signal) => {
      registration.dead = true
      worker.notify("proc.exit", { processId, code, signal })
    })
    proc.onError((error) => {
      // Contract: a terminal proc.exit always follows this frame.
      worker.notify("proc.error", { processId, message: error.message })
    })
    log.debug("extension worker process spawn", { ...detail("process"), processId, pid: proc.pid, command })
    return { processId, pid: proc.pid ?? null }
  }

  async function onHostCall(method: string, value: Schema.Json): Promise<Schema.Json> {
    const input = value === null || value === undefined ? {} : record(value, `${method} value`)
    switch (method) {
      case "host.spawn":
        return spawnHosted(input)
      case "proc.stdin-end": {
        const proc = hosted(input)
        proc?.proc.stdin?.end()
        return null
      }
      case "proc.kill": {
        const proc = hosted(input)
        proc?.proc.kill(input.signal === "KILL" ? "KILL" : "TERM")
        return null
      }
      case "tool.ask": {
        const call = optionalString(input.call)
        const ctx = call ? activeCalls.get(call) : undefined
        if (!ctx) throw new HostProcessError({ code: "closed", detail: "tool.ask for a completed call" })
        await ctx.ask(input.ask)
        return null
      }
      default:
        throw new HostProcessError({ code: "denied", detail: `unsupported host.call: ${method}` })
    }
  }

  function onNotify(method: string, value: Schema.Json) {
    if (!deps.available() || stopped) return
    const input = value === null || value === undefined ? {} : (value as Record<string, unknown>)
    switch (method) {
      case "module.shape": {
        const body = record(input, "module.shape value")
        shape = {
          server: body.server === true,
          rpc: Array.isArray(body.rpc) ? body.rpc.filter((m): m is string => typeof m === "string") : [],
          dispose: body.dispose === true,
        }
        return
      }
      case "host.emit": {
        const body = record(input, "host.emit value")
        deps.emit(optionalString(body.name) ?? "event", body.data, optionalString(body.directory))
        return
      }
      case "host.log": {
        const body = record(input, "host.log value")
        const level = optionalString(body.level)
        const message = optionalString(body.message) ?? ""
        const extra = typeof body.extra === "object" && body.extra !== null ? (body.extra as object) : {}
        const write = level === "error" ? log.error : level === "warn" ? log.warn : level === "info" ? log.info : log.debug
        write(`extension worker: ${message}`, { extension: id, ...extra })
        return
      }
      case "runtime.error": {
        const body = record(input, "runtime.error value")
        deps.runtimeError(optionalString(body.phase) ?? "worker", optionalString(body.message) ?? "unknown")
        return
      }
      case "tool.metadata": {
        const body = record(input, "tool.metadata value")
        const call = optionalString(body.call)
        const ctx = call ? activeCalls.get(call) : undefined
        if (!ctx) return
        const result = ctx.metadata({
          ...(body.title !== null && body.title !== undefined ? { title: String(body.title) } : {}),
          ...(body.metadata !== null && body.metadata !== undefined
            ? { metadata: body.metadata as Record<string, unknown> }
            : {}),
        })
        // The host tool context reports metadata through an Effect (the
        // prompt's part updater); run it so the update actually lands.
        if (result && typeof result === "object" && Effect.isEffect(result)) {
          void Effect.runPromise(result as Effect.Effect<void>).catch((error) =>
            log.error("extension tool metadata callback failed", { ...detail("tool"), error }),
          )
        }
        return
      }
      case "proc.stdin": {
        const proc = hosted(record(input, "proc.stdin value"))
        const data = input.data
        if (proc && typeof data === "string") proc.proc.stdin?.write(Buffer.from(data, "base64"))
        return
      }
      case "proc.credit": {
        const body = record(input, "proc.credit value")
        const proc = hosted(body)
        const bytes = typeof body.bytes === "number" && body.bytes > 0 ? body.bytes : 0
        if (proc && bytes) refillCredit(proc, bytes)
        return
      }
      default:
        log.debug("extension worker unknown notify", { ...detail("notify"), method })
    }
  }

  // `bun test`/Electron launchers cannot re-exec themselves as the worker
  // entrypoint, so the full argv prefix can be overridden as JSON (design
  // §9's self-exec contract); production falls back to self re-exec.
  const override = process.env.OPENCODE_EXTENSION_HOST_ARGV?.trim()
  const template = override
    ? (JSON.parse(override) as string[])
    : resolveSelfArgv(["extension-host", "--identity", "@OPENCODE_EXTENSION_IDENTITY@"], {
        execPath: process.execPath,
        argv: process.argv,
        env: process.env,
        electron: "electron" in process.versions,
        // Source-mode dev launches carry `--conditions=browser` et al. in
        // execArgv; the worker must inherit them so module resolution matches
        // the host (process-isolation-design.md Q2).
        execArgv: process.execArgv,
      })
  const executable = template[0]!
  const args = (identity: unknown) =>
    override
      ? [...template.slice(1), "--identity", JSON.stringify(identity)]
      : template.slice(1).map((arg) => (arg === "@OPENCODE_EXTENSION_IDENTITY@" ? JSON.stringify(identity) : arg))

  let workerScope: Scope.Closeable | undefined
  const worker = await supervisorRuntime.runPromise((svc) =>
    Effect.gen(function* () {
      const spawnScope = yield* Scope.make()
      const spawned = yield* svc
        .spawn({
          extension: id,
          fence: {
            store: deps.registry,
            installation: deps.installation,
            generation: deps.gen,
            epoch: deps.epoch,
          },
          executable,
          args: args as SpawnInput["args"],
          limits: deps.limits(),
          hooks: {
            init: {
              id: deps.manifest.id,
              version: deps.manifest.version,
              dir: deps.manifest.dir,
              entry: deps.entry.source!,
              dataDir: deps.dataDir,
              cacheDir: deps.cacheDir,
              ...(deps.serverUrl ? { serverUrl: deps.serverUrl.href } : {}),
              settings: deps.entry.settings as Schema.Json,
            },
            onNotify,
            onHostCall,
            onCrash(exit) {
              if (!deps.available() || stopped) return
              for (const proc of processes.values()) proc.dead = true
              processes.clear()
              scopeDisposal()
              deps.crashed(exit)
            },
            onReady() {
              if (!deps.available() || stopped || worker.info().crashes === 0) return
              // A fresh generation scope: the crashed one's scope is closed.
              scopeClosed = false
              scope = openScope()
              deps.entry.resources.add(scopeDisposal)
              deps.restarted()
            },
            onExhausted(exit) {
              if (!deps.available() || stopped) return
              deps.exhausted(exit)
            },
          },
        })
        .pipe(Scope.provide(spawnScope))
      return { spawned, scope: spawnScope }
    }),
  ).then(({ spawned, scope: spawnScope }) => {
    workerScope = spawnScope
    return spawned
  })

  /**
   * Worker-death errors are normalized to `extension_crashed` (duck-typed on
   * the runtime's ExtensionRpcError shape) — instance dispose must swallow
   * those because a dead worker already ran teardown.
   */
  const workerGone = (error: unknown) =>
    error instanceof Error && error.name === "ExtensionRpcError" && (error as { code?: unknown }).code === "extension_crashed"

  function normalize(cause: unknown, method: string): Error {
    if (cause instanceof HostProcessError) {
      if (cause.code === "cancelled") return deps.errors.aborted(method)
      if (cause.code === "capacity") return deps.errors.rpc("busy", `Extension host process is busy: ${id}`)
      // Preserve the worker-side detail (e.g. an ask denial or a tool throw) so
      // callers observe the same message the inline backend would surface.
      const detail = cause.detail ? `: ${cause.detail}` : ""
      return deps.errors.rpc("extension_crashed", `Extension host process unavailable: ${id} (${cause.code})${detail}`)
    }
    return cause instanceof Error ? cause : new Error(String(cause))
  }

  async function request(method: string, value: unknown, signal: AbortSignal | undefined, timeoutMs?: number) {
    const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    )
    const merged = signals.length ? AbortSignal.any(signals) : undefined
    try {
      return await worker.request(method, (value ?? null) as Schema.Json, merged)
    } catch (cause) {
      throw normalize(cause, method)
    }
  }

  function unwrapRpcResult(value: unknown, method: string): unknown {
    const result = record(value, `${method} result`)
    if (result.status === "ok") return result.value
    if (result.status === "notFound") throw deps.errors.notFound(method)
    if (result.status === "error") {
      const body = record(result, `${method} error`)
      throw deps.errors.rpc(
        typeof body.code === "string" ? body.code : "error",
        typeof body.message === "string" ? body.message : `Extension RPC failed: ${id}.${method}`,
      )
    }
    throw deps.errors.rpc("protocol", `Extension worker returned an invalid RPC result: ${id}.${method}`)
  }

  async function toolExecute(directory: string, tool: string, args: unknown, ctx: ToolContext) {
    const call = randomUUID()
    activeCalls.set(call, {
      metadata: (input) => ctx.metadata?.(input),
      ask: (input) => Promise.resolve(ctx.ask?.(input as never)),
    })
    try {
      const result = await request(
        "tool.execute",
        {
          directory,
          tool,
          call,
          args: (args ?? null) as Schema.Json,
          ctx: {
            sessionID: ctx.sessionID ?? "",
            messageID: ctx.messageID ?? "",
            agent: ctx.agent ?? "",
            directory: ctx.directory ?? directory,
            worktree: ctx.worktree ?? "",
          },
        },
        ctx.abort,
      )
      return result
    } finally {
      activeCalls.delete(call)
    }
  }

  return {
    info: () => worker.info(),
    async ready() {
      await worker.ready()
      return shape ?? { server: false, rpc: [], dispose: false }
    },
    async serviceRpc(method, input, ctx) {
      const value = await request(
        "service.rpc",
        { method, input: input ?? null, directory: ctx.directory ?? null },
        ctx.signal,
        deps.requestTimeoutMs(),
      )
      return unwrapRpcResult(value, `service.${method}`)
    },
    async instanceStart(input, signal) {
      const value = await request(
        "instance.start",
        {
          directory: input.directory,
          worktree: input.worktree ?? input.directory,
          project: (input.project ?? null) as Schema.Json,
          serverUrl: input.serverUrl?.href ?? deps.serverUrl?.href ?? null,
          options: null,
        },
        signal,
      )
      const body = record(value, "instance.start result")
      const tools = Array.isArray(body.tools) ? (body.tools as ToolDescriptor[]) : []
      const rpc = Array.isArray(body.rpc) ? body.rpc.filter((m): m is string => typeof m === "string") : []
      const directory = input.directory
      const hooks: ExtensionHooks = {}
      if (rpc.length) {
        hooks.rpc = Object.fromEntries(
          rpc.map((method) => [
            method,
            async (value: unknown, ctx: { directory?: string; signal: AbortSignal }) => {
              const result = await request(
                "instance.rpc",
                { directory, method, input: value ?? null },
                ctx.signal,
                deps.requestTimeoutMs(),
              )
              return unwrapRpcResult(result, method)
            },
          ]),
        )
      }
      if (tools.length) {
        hooks.tool = Object.fromEntries(
          tools.map((descriptor) => [
            descriptor.name,
            {
              description: descriptor.description,
              args: {},
              // The worker-side JSON Schema rides through the ToolRegistry
              // unchanged so the model sees the exact schema the extension
              // declared (T5.3: parameters pass-through).
              parameters: descriptor.parameters,
              execute: (args: unknown, ctx: ToolContext) =>
                toolExecute(directory, descriptor.name, args, ctx) as Promise<never>,
            },
          ]),
        ) as ExtensionHooks["tool"]
      }
      if (body.event === true) {
        hooks.event = (input: { event?: unknown }) => {
          worker.notify("instance.event", { directory, event: (input?.event ?? input ?? null) as Schema.Json })
          return Promise.resolve()
        }
      }
      hooks.dispose = async () => {
        try {
          await request("instance.dispose", { directory }, undefined)
        } catch (error) {
          // A dead worker already ran teardown; only a live worker's disposal
          // failure may surface as failedDisposal.
          if (workerGone(error)) {
            log.debug("extension instance dispose skipped: worker gone", detail("dispose"))
            return
          }
          throw error
        }
      }
      return hooks
    },
    settingsChanged(values) {
      worker.notify("settings.changed", { values: values as Schema.Json })
    },
    async stop() {
      if (stopped) return worker.stop()
      stopped = true
      scopeDisposal()
      const result = await worker.stop()
      if (workerScope) await Effect.runPromise(Scope.close(workerScope, Exit.void)).catch(() => {})
      return result
    },
  }
}

export * as HostWorkerDriver from "./host-worker"
