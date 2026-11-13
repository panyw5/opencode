import { Buffer } from "node:buffer"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Readable, Writable } from "node:stream"
import type { Schema } from "effect"
import type {
  ExtensionHooks,
  ExtensionHost,
  ExtensionPluginInput,
  ExtensionService,
  ExtensionSpawnOptions,
  ManagedProcess,
  RpcHandler,
  ServerExtension,
} from "@opencode-ai/extension-kit/server"
import type { PluginOptions, ToolContext, ToolDefinition } from "@opencode-ai/plugin"
import { toolArgsJsonSchema } from "../../plugin/tool-schema.ts"
import { makeTimerScope } from "../runtime/timers.ts"
import { HostProcessError } from "./protocol.ts"
import type { WorkerApplication, WorkerHost } from "./worker.ts"

/**
 * Concrete extension loader for the worker process (T5.2). Implements the
 * proxy surface of `process-isolation-design.md` §3 on top of the protocol
 * endpoint in `worker.ts`:
 *
 * - `init` payload carries extension dir/entry/settings snapshot/identity;
 *   the entry is `import()`ed and `activate()`d before `ready` is reported.
 * - `host.settings` is a synchronous local cache, updated by
 *   `settings.changed` notifies (cache first, then listeners — §3.2).
 * - `host.emit`/`host.log` are notify frames; `host.spawn` is a reverse
 *   `host.call` with the proc.* stream/exit data plane (§3.3).
 * - Timers are worker-local (§3.4): the worker process itself is the
 *   generation, so raw and scoped timers die with it alike.
 * - `input.client`/`input.$`/`experimental_workspace` are throwing stubs
 *   (§3.5, decision Q7); unsupported mutable-output hooks are rejected at
 *   `instance.start` (T5.0 item 3).
 *
 * This module is loaded by real worker processes under both Bun and Node
 * type-stripping, so it must stay free of `@/` path aliases and heavy
 * imports — the same constraint as the rest of `host-process/`.
 */

/** `init` command payload delivered after `hello` (design §1.2). */
export type WorkerInitPayload = {
  id: string
  version: string
  /** Extension package directory; also the worker's cwd (design §9). */
  dir: string
  /** Absolute path of the server entry module to import. */
  entry: string
  dataDir: string
  cacheDir: string
  serverUrl?: string
  /** `resolveSettings` snapshot — stored values plus manifest defaults. */
  settings: Record<string, unknown>
}

/** Result envelope for `service.rpc` / `instance.rpc` requests. */
type RpcResult =
  | { status: "ok"; value: Schema.Json }
  | { status: "notFound" }
  | { status: "error"; code: string; message: string }

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`extension worker ${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.length)
    throw new Error(`extension worker ${label} must be a non-empty string`)
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return
  return string(value, label)
}

function parseInit(init: Schema.Json): WorkerInitPayload {
  const value = record(init, "init payload")
  const entry = string(value.entry, "init payload entry")
  if (!path.isAbsolute(entry)) throw new Error(`extension worker init entry must be absolute: ${entry}`)
  return {
    id: string(value.id, "init payload id"),
    version: string(value.version, "init payload version"),
    dir: string(value.dir, "init payload dir"),
    entry,
    dataDir: string(value.dataDir, "init payload dataDir"),
    cacheDir: string(value.cacheDir, "init payload cacheDir"),
    serverUrl: optionalString(value.serverUrl, "init payload serverUrl"),
    settings: value.settings === undefined ? {} : record(value.settings, "init payload settings"),
  }
}

/** Duck-typed `ExtensionRpcError` from the extension-kit contract. */
function duckRpcError(cause: unknown): { code: string; message: string } | undefined {
  if (!cause || typeof cause !== "object") return
  const candidate = cause as { name?: unknown; code?: unknown; message?: unknown }
  if (candidate.name !== "ExtensionRpcError" || typeof candidate.code !== "string") return
  return { code: candidate.code, message: typeof candidate.message === "string" ? candidate.message : "" }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Extension-visible stub for surface denied under process isolation. */
function denied(detail: string) {
  return new HostProcessError({ code: "denied", detail })
}

type ProxyRegistration = {
  processId?: string
  pid?: number
  /** Bytes pushed into the proxy stream but not yet returned as `proc.credit`. */
  outstanding: number
  /** Host data not yet pushed (extension consumed slower than it arrived). */
  outPending: Buffer[]
  errPending: Buffer[]
  /** A `proc.credit` flush is already scheduled for this tick. */
  creditScheduled: boolean
  proc: ManagedProcess & { exitCode: number | null; exitSignal: string | null; exited: boolean; killed: boolean }
  stdout: Readable | null
  stderr: Readable | null
  exits: Set<(code: number | null, signal: string | null) => void>
  errors: Set<(error: Error) => void>
  ready: { promise: Promise<void>; resolve: () => void; reject: (cause: unknown) => void }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

type Instance = {
  directory: string
  hooks: ExtensionHooks
  tools: Map<string, ToolDefinition>
}

/** Instance-level hook keys supported under process isolation (design §3.1). */
const SUPPORTED_HOOKS = new Set(["tool", "rpc", "event", "dispose"])

/**
 * Build the `load` implementation for `serveWorker`: import the extension's
 * server entry, construct the proxied `ExtensionHost`, run `activate`, and
 * return the application dispatcher the protocol endpoint drives.
 */
export async function loadExtensionApplication(
  init: Schema.Json,
  host: WorkerHost,
  signal: AbortSignal,
): Promise<WorkerApplication> {
  const payload = parseInit(init)
  const stderr = (event: string) => process.stderr.write(`extension-host ${payload.id} ${event}\n`)
  // The worker's cwd is the extension directory (design §9): extension code
  // reaching for process.cwd() sees its own package, not the sidecar's cwd.
  process.chdir(payload.dir)

  let closed = false
  let service: ExtensionService | undefined
  let settingsCache: Record<string, unknown> = { ...payload.settings }
  const settingsListeners = new Set<(next: Record<string, unknown>) => void>()
  const instances = new Map<string, Instance>()
  const processes = new Map<string, ProxyRegistration>()
  /**
   * proc.* frames are strictly ordered on one pipe, but the registration they
   * target only exists once the `host.result` of `host.spawn` resolves — a
   * microtask hop the synchronous frame pump can overtake when the host
   * reports proc.* in the same chunk (e.g. an instantly-failing spawn, or a
   * chatty child). Buffer per processId until registration; ids in
   * `deadProc` already settled so their late frames drop instead.
   */
  const earlyProc = new Map<string, { method: string; input: Record<string, unknown> }[]>()
  const deadProc = new Set<string>()
  const pending = new Set<Promise<unknown>>()
  const track = (promise: Promise<unknown>) => {
    pending.add(promise)
    const drop = () => pending.delete(promise)
    void promise.then(drop, drop)
  }

  const fire = (method: string, value: Schema.Json) => {
    try {
      void host.notify(method, value).catch((cause) => stderr(`notify-failed method=${method} ${message(cause)}`))
    } catch (cause) {
      stderr(`notify-failed method=${method} ${message(cause)}`)
    }
  }

  const timers = makeTimerScope({
    available: () => !closed,
    track,
    onError(cause) {
      const text = message(cause)
      stderr(`timer-failed ${text}`)
      fire("runtime.error", { phase: "timer", message: text })
      fire("host.log", { level: "error", message: `extension timer failed: ${text}` })
    },
  })

  function credit(registration: ProxyRegistration) {
    if (!registration.processId || registration.outstanding <= 0) return
    const bytes = registration.outstanding
    registration.outstanding = 0
    fire("proc.credit", { processId: registration.processId, bytes })
  }

  /**
   * Credit rides on delivered bytes only: data sitting in `pending` (or in
   * the Readable's own buffer when the extension isn't consuming) is not
   * credited, so a stalled extension stops the host at its credit budget —
   * the §3.3 memory bound. `_read` is not reliable consumption signal in
   * flowing mode (it is skipped while the buffer stays above the high water
   * mark), so credit is batched one flush per drain rather than per _read.
   */
  function drainProc(registration: ProxyRegistration, target: Readable | null, pending: Buffer[]) {
    if (!target) return
    while (pending.length && target.push(pending[0]!)) {
      registration.outstanding += pending.shift()!.length
    }
    if (registration.creditScheduled) return
    registration.creditScheduled = true
    queueMicrotask(() => {
      registration.creditScheduled = false
      credit(registration)
    })
  }

  function routeProc(registration: ProxyRegistration, method: string, input: Record<string, unknown>) {
    switch (method) {
      case "proc.stdout":
      case "proc.stderr": {
        const isOut = method === "proc.stdout"
        const target = isOut ? registration.stdout : registration.stderr
        const pending = isOut ? registration.outPending : registration.errPending
        if (!target) return
        pending.push(Buffer.from(string(input.data, `${method} data`), "base64"))
        drainProc(registration, target, pending)
        return
      }
      case "proc.exit":
        settle(
          registration,
          typeof input.code === "number" ? input.code : null,
          typeof input.signal === "string" ? input.signal : null,
        )
        return
      case "proc.error": {
        const error = new Error(optionalString(input.message, "proc.error message") ?? "extension process error")
        for (const listener of registration.errors) listener(error)
        // Host contract: a terminal proc.exit frame always follows.
        return
      }
    }
  }

  function settle(registration: ProxyRegistration, code: number | null, signal: string | null) {
    if (registration.proc.exited) return
    registration.proc.exited = true
    registration.proc.exitCode = code
    registration.proc.exitSignal = signal
    if (registration.processId) {
      processes.delete(registration.processId)
      deadProc.add(registration.processId)
      earlyProc.delete(registration.processId)
    }
    // Flush any host data still queued before the EOF so 'end' consumers see
    // the complete stream; outstanding bytes are credited once at close.
    for (const [target, pending] of [
      [registration.stdout, registration.outPending],
      [registration.stderr, registration.errPending],
    ] as const) {
      if (!target) continue
      try {
        while (pending.length) {
          registration.outstanding += pending[0]!.length
          target.push(pending.shift()!)
        }
        target.push(null)
      } catch {}
    }
    credit(registration)
    for (const listener of registration.exits) listener(code, signal)
  }

  function spawnProxy(command: string, args: string[] = [], options: ExtensionSpawnOptions = {}): ManagedProcess {
    if (closed) throw new Error(`Extension host is disposed and cannot spawn: ${payload.id}`)
    const stdio = options.stdio ?? (["ignore", "pipe", "pipe"] as const)
    const registration: ProxyRegistration = {
      outstanding: 0,
      outPending: [],
      errPending: [],
      creditScheduled: false,
      stdout: null,
      stderr: null,
      exits: new Set<(code: number | null, signal: string | null) => void>(),
      errors: new Set<(error: Error) => void>(),
      ready: deferred<void>(),
      proc: undefined as unknown as ProxyRegistration["proc"],
    }
    const stream = (piped: boolean, pending: Buffer[]) => {
      if (!piped) return null
      const readable = new Readable({
        // Match the host-side credit budget (256 KiB, design §3.3): data can
        // flow into the extension's buffer without a _read round-trip, while
        // `pending` + this buffer still bounds worker memory for a stalled
        // consumer to roughly one credit window.
        highWaterMark: 256 * 1024,
        read() {
          // Extension consumed buffered bytes — flush pending and settle credit.
          drainProc(registration, readable, pending)
        },
      })
      readable.once("close", () => credit(registration))
      return readable
    }
    registration.stdout = stream(stdio[1] === "pipe", registration.outPending)
    registration.stderr = stream(stdio[2] === "pipe", registration.errPending)
    const stdin =
      stdio[0] !== "pipe"
        ? null
        : new Writable({
            write(chunk, _encoding, callback) {
              void registration.ready.promise
                .then(() =>
                  host.notify("proc.stdin", {
                    processId: registration.processId!,
                    data: Buffer.from(chunk).toString("base64"),
                  }),
                )
                .then(
                  () => callback(),
                  (cause) => callback(cause instanceof Error ? cause : new Error(String(cause))),
                )
            },
            final(callback) {
              void registration.ready.promise
                .then(() => host.call("proc.stdin-end", { processId: registration.processId ?? null }))
                .then(
                  () => callback(),
                  // stdin teardown is best-effort; the host may already be gone.
                  () => callback(),
                )
            },
          })
    registration.proc = {
      get pid() {
        return registration.pid
      },
      stdin,
      stdout: registration.stdout,
      stderr: registration.stderr,
      exitCode: null,
      exitSignal: null,
      exited: false,
      killed: false,
      onExit(listener: (code: number | null, signal: string | null) => void) {
        registration.exits.add(listener)
        return () => registration.exits.delete(listener)
      },
      onError(listener: (error: Error) => void) {
        registration.errors.add(listener)
        return () => registration.errors.delete(listener)
      },
      kill(signal: "TERM" | "KILL" = "TERM") {
        registration.proc.killed = true
        void registration.ready.promise
          .then(() => host.call("proc.kill", { processId: registration.processId ?? null, signal }))
          .catch(() => {})
      },
    }

    // `env` may carry undefined values, which are not Schema.Json — strip them
    // at the boundary rather than failing the frame.
    const env = options.env
      ? Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : null
    // Permission checkpoint (T5.6): the host-side host.call admission will
    // reject spawn requests with "denied" when the manifest lacks
    // "process:spawn"; the rejection surfaces here as an onError + exit.
    void host.call("host.spawn", { command, args, env, cwd: options.cwd ?? null, stdio: [...stdio] }).then(
      (value) => {
        const result = record(value, "host.spawn result")
        const processId = string(result.processId, "host.spawn result processId")
        registration.processId = processId
        registration.pid = typeof result.pid === "number" ? result.pid : undefined
        processes.set(processId, registration)
        // Replay frames that overtook the host.result microtask (see earlyProc).
        const early = earlyProc.get(processId)
        if (early) {
          earlyProc.delete(processId)
          for (const frame of early) routeProc(registration, frame.method, frame.input)
        }
        registration.ready.resolve()
      },
      (cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause))
        for (const listener of registration.errors) listener(error)
        registration.ready.reject(error)
        settle(registration, null, null)
      },
    )
    return registration.proc
  }

  const proxyHost: ExtensionHost = {
    id: payload.id,
    version: payload.version,
    dataDir: payload.dataDir,
    cacheDir: payload.cacheDir,
    serverUrl: new URL(payload.serverUrl ?? "http://127.0.0.1"),
    settings: {
      get: () => ({ ...settingsCache }),
      onDidChange(listener) {
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      },
    },
    setTimeout: timers.setTimeout,
    setInterval: timers.setInterval,
    spawn: spawnProxy,
    emit(name, data, options) {
      fire("host.emit", { name, data: (data ?? null) as Schema.Json, directory: options?.directory ?? null })
    },
    log: {
      debug: (message, extra) => fire("host.log", { level: "debug", message, extra: extra ?? null }),
      info: (message, extra) => fire("host.log", { level: "info", message, extra: extra ?? null }),
      warn: (message, extra) => fire("host.log", { level: "warn", message, extra: extra ?? null }),
      error: (message, extra) => fire("host.log", { level: "error", message, extra: extra ?? null }),
    },
  }

  // Worker-local stubs for PluginInput surface that cannot cross the process
  // boundary (design §3.5, decision Q7). Access is a truthy object so optional
  // chaining still reaches a clear, thrown explanation.
  const client = new Proxy(
    {},
    {
      get() {
        throw denied(
          "input.client is not available to process-isolated extensions in v1; credentials are reserved via the fd init payload",
        )
      },
    },
  )
  const dollar = new Proxy(() => {}, {
    get() {
      throw new Error("input.$ (BunShell) is not available under process isolation; use host.spawn instead")
    },
    apply() {
      throw new Error("input.$ (BunShell) is not available under process isolation; use host.spawn instead")
    },
  })
  const experimentalWorkspace = {
    register() {
      throw new Error("input.experimental_workspace.register is not supported under process isolation")
    },
  }

  async function rpcResult(
    handlers: Record<string, RpcHandler> | undefined,
    method: string,
    input: unknown,
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<RpcResult> {
    const handler = handlers?.[method]
    if (!handler) return { status: "notFound" }
    try {
      const value = await handler(input, { directory, signal })
      return { status: "ok", value: (value ?? null) as Schema.Json }
    } catch (cause) {
      const rpc = duckRpcError(cause)
      if (rpc) return { status: "error", code: rpc.code, message: rpc.message }
      throw cause
    }
  }

  function disposeInstance(instance: Instance) {
    if (instances.get(instance.directory) === instance) instances.delete(instance.directory)
    return Promise.resolve()
      .then(() => instance.hooks.dispose?.())
      .catch((cause) => stderr(`instance-dispose-failed directory=${instance.directory} ${message(cause)}`))
  }

  async function instanceStart(value: Record<string, unknown>, signal: AbortSignal) {
    const directory = string(value.directory, "instance.start directory")
    const server = extensionModule?.server
    if (!server) return { tools: [], rpc: [], event: false }
    const input = {
      directory,
      worktree: optionalString(value.worktree, "instance.start worktree") ?? directory,
      project: value.project ?? null,
      serverUrl: new URL(optionalString(value.serverUrl, "instance.start serverUrl") ?? proxyHost.serverUrl.href),
      client,
      experimental_workspace: experimentalWorkspace,
      $: dollar,
      extension: Object.assign(proxyHost, { service }),
    } as unknown as ExtensionPluginInput
    const hooks = ((await server(input, value.options as PluginOptions | undefined)) ?? {}) as ExtensionHooks
    if (signal.aborted) {
      await disposeInstance({ directory, hooks, tools: new Map() })
      throw new HostProcessError({ code: "cancelled" })
    }
    const unsupported = Object.keys(hooks).filter((key) => !SUPPORTED_HOOKS.has(key))
    if (unsupported.length) {
      await disposeInstance({ directory, hooks, tools: new Map() })
      throw new Error(
        `Extension ${payload.id} declares unsupported hooks under process isolation: ${unsupported.join(", ")} — only tool/rpc/event/dispose are proxied (process-isolation-design.md §3.1)`,
      )
    }
    const tools = new Map<string, ToolDefinition>()
    const descriptors: { name: string; description: string; parameters: unknown }[] = []
    // Permission checkpoint (T5.6): the host validates the declared "tools"
    // permission against this descriptor before registering proxy tools;
    // a worker cannot bypass that gate because ToolRegistry lives host-side.
    for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
      const candidate = definition as ToolDefinition
      if (typeof candidate?.execute !== "function")
        throw new Error(`Extension ${payload.id} tool ${name} is missing an execute function`)
      tools.set(name, candidate)
      descriptors.push({
        name,
        description: typeof candidate.description === "string" ? candidate.description : "",
        parameters: toolArgsJsonSchema(candidate.args as Record<string, unknown> | undefined),
      })
    }
    const instance: Instance = { directory, hooks, tools }
    const original = hooks.dispose?.bind(hooks)
    hooks.dispose = async () => {
      instances.delete(directory)
      await original?.()
    }
    const existing = instances.get(directory)
    if (existing) await disposeInstance(existing)
    instances.set(directory, instance)
    return {
      tools: descriptors,
      rpc: Object.keys(hooks.rpc ?? {}),
      event: typeof hooks.event === "function",
    }
  }

  async function toolExecute(value: Record<string, unknown>, signal: AbortSignal) {
    const directory = string(value.directory, "tool.execute directory")
    const name = string(value.tool, "tool.execute tool")
    const call = string(value.call, "tool.execute call")
    const instance = instances.get(directory)
    if (!instance) throw new HostProcessError({ code: "requestFailed", detail: `no instance for directory ${directory}` })
    const definition = instance.tools.get(name)
    if (!definition) throw new HostProcessError({ code: "requestFailed", detail: `unknown tool ${payload.id}.${name}` })
    const context = record(value.ctx ?? {}, "tool.execute ctx")
    const toolContext: ToolContext = {
      sessionID: optionalString(context.sessionID, "tool.execute ctx.sessionID") ?? "",
      messageID: optionalString(context.messageID, "tool.execute ctx.messageID") ?? "",
      agent: optionalString(context.agent, "tool.execute ctx.agent") ?? "",
      directory: optionalString(context.directory, "tool.execute ctx.directory") ?? directory,
      worktree: optionalString(context.worktree, "tool.execute ctx.worktree") ?? directory,
      abort: signal,
      metadata(input) {
        fire("tool.metadata", {
          call,
          title: input?.title ?? null,
          metadata: (input?.metadata ?? null) as Schema.Json,
        })
      },
      async ask(input) {
        // Reverse request (design §2.2): the host answers host.result, or
        // host.rejected — a denial throws here, matching host deny semantics.
        await host.call("tool.ask", { call, ask: input as unknown as Schema.Json })
      },
    }
    const execute = definition.execute as (args: unknown, ctx: ToolContext) => Promise<unknown>
    const result = await execute(value.args, toolContext)
    return (result ?? null) as Schema.Json
  }

  // ── Extension loading: chdir → import → activate → ready ────────────────
  const url = pathToFileURL(payload.entry).href
  stderr(`import-start entry=${payload.entry}`)
  const imported = (await import(url)) as { default?: unknown }
  const extensionModule = imported.default as ServerExtension | undefined
  if (!extensionModule || typeof extensionModule !== "object")
    throw new Error(`Extension server entry has no default export: ${payload.entry}`)
  if (extensionModule.id !== payload.id)
    throw new Error(`Extension server id mismatch: entry exports ${String(extensionModule.id)}, expected ${payload.id}`)
  stderr("import-ok")
  const activated = (await extensionModule.activate?.(proxyHost)) as ExtensionService | void
  if (signal.aborted) {
    await (activated as ExtensionService | undefined)?.dispose?.().catch(() => {})
    throw new HostProcessError({ code: "cancelled" })
  }
  service = (activated ?? {}) as ExtensionService
  stderr("activate-ok")

  return {
    async request(method, value, signal) {
      const input = value === null || value === undefined ? {} : record(value, `${method} value`)
      switch (method) {
        case "service.rpc":
          return (await rpcResult(
            service?.rpc,
            string(input.method, "service.rpc method"),
            input.input ?? null,
            optionalString(input.directory, "service.rpc directory"),
            signal,
          )) as Schema.Json
        case "instance.start":
          return (await instanceStart(input, signal)) as Schema.Json
        case "instance.rpc": {
          const directory = string(input.directory, "instance.rpc directory")
          const instance = instances.get(directory)
          if (!instance) return { status: "notFound" } as Schema.Json
          return (await rpcResult(
            instance.hooks.rpc,
            string(input.method, "instance.rpc method"),
            input.input ?? null,
            directory,
            signal,
          )) as Schema.Json
        }
        case "instance.dispose": {
          const directory = string(input.directory, "instance.dispose directory")
          const instance = instances.get(directory)
          if (!instance) return { disposed: false } as Schema.Json
          await disposeInstance(instance)
          return { disposed: true } as Schema.Json
        }
        case "tool.execute":
          return await toolExecute(input, signal)
        default:
          throw new HostProcessError({ code: "requestFailed", detail: `unknown worker method ${method}` })
      }
    },
    async notify(method, value) {
      const input = value === null || value === undefined ? {} : record(value, `${method} value`)
      switch (method) {
        case "settings.changed": {
          // Cache before listeners so a listener's get() sees the update
          // (design §3.2, same ordering as runtime notifySettings).
          const next = record(input.values ?? input, "settings.changed values")
          settingsCache = { ...next }
          for (const listener of settingsListeners) {
            try {
              listener({ ...settingsCache })
            } catch (cause) {
              stderr(`settings-listener-failed ${message(cause)}`)
            }
          }
          return
        }
        case "instance.event": {
          const directory = string(input.directory, "instance.event directory")
          const instance = instances.get(directory)
          if (!instance) return
          await instance.hooks.event?.({ event: input.event as never })
          return
        }
        case "proc.stdout":
        case "proc.stderr":
        case "proc.exit":
        case "proc.error": {
          const processId = string(input.processId, `${method} processId`)
          const registration = processes.get(processId)
          if (!registration) {
            if (deadProc.has(processId)) return
            const queue = earlyProc.get(processId) ?? []
            if (queue.length >= 256) {
              stderr(`proc-buffer-overflow processId=${processId}`)
              return
            }
            queue.push({ method, input })
            earlyProc.set(processId, queue)
            return
          }
          routeProc(registration, method, input)
          return
        }
        default:
          stderr(`unknown-notify method=${method}`)
      }
    },
    async dispose() {
      closed = true
      timers.dispose()
      const list = [...instances.values()]
      instances.clear()
      for (const instance of list) await disposeInstance(instance)
      await service?.dispose?.()
      await Promise.allSettled(pending)
      // Host-owned children are reaped by the host on worker exit; the local
      // registrations only feed stream/event routing.
      processes.clear()
      earlyProc.clear()
      deadProc.clear()
    },
  }
}

export * as HostProcessApplication from "./application.ts"
