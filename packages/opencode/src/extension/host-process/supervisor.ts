import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import {
  decodeWorkerEvent,
  HostProcessError,
  makeIdentity,
  PROTOCOL_VERSION,
  RequestID,
  sameRuntime,
  type RuntimeIdentity,
  type WorkerEvent,
} from "./protocol.ts"
import { spawnWorkerTransport, type RootExit, type WorkerTransport } from "./transport.ts"

const log = Log.create({ service: "extension" })

/** Failed steps remain visible even when the execution root eventually exits. */
export type StopIssue =
  | HostProcessError["code"]
  | "drainDeadline"
  | "exitDeadline"
  | "disposeDeadline"
  | "disposeFailed"
  | "terminationFailed"
  | "releaseFailed"
/** Root exit alone never authorizes removal of a generation or installation. */
export type StopResult =
  | { status: "rootExited"; exit: RootExit; tree: "unproven"; issues: readonly StopIssue[]; failure?: HostProcessError }
  | { status: "unknown"; tree: "unproven"; issues: readonly StopIssue[]; failure?: HostProcessError }

type Completion = { ok: true } | { ok: false; error: HostProcessError }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function within<T>(promise: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then((value) => ({ done: true as const, value })),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export type SupervisorLimits = {
  /** Bytes in one newline-delimited control frame. */
  frameBytes: number
  /** Frames or equivalent queued bytes on either direction. */
  bufferedFrames: number
  /** hello+ready admission deadline. */
  readinessMs: number
  /** Graceful drain deadline before forced termination. */
  drainMs: number
  /** Disposal deadline before forced termination. */
  disposeMs: number
  /** OS-root exit observation deadline after forced termination. */
  exitMs: number
  /** Maximum in-flight requests admitted by the worker boundary. */
  maxPending: number
  /** Crash restart backoff skeleton; one delay per attempt (design section 5). */
  restartBackoffMs: readonly number[]
}

/** Production defaults mirroring design section 2.3; testing.setLimits may shorten them. */
export const DEFAULT_LIMITS: SupervisorLimits = {
  frameBytes: 1024 * 1024,
  bufferedFrames: 64,
  readinessMs: 10_000,
  drainMs: 5_000,
  disposeMs: 10_000,
  exitMs: 5_000,
  maxPending: 32,
  restartBackoffMs: [1_000, 5_000, 30_000],
}

export type SupervisorHooks = {
  /** Payload delivered in the `init` command following `hello`; T5.2 defines its concrete shape. */
  init?: Schema.Json
  /** Fire-and-forget worker `notify` events (progress, streaming partials). */
  onNotify?: (method: string, value: Schema.Json) => void
  /** Reverse-channel handler; when absent, `host.call` is denied. */
  onHostCall?: (method: string, value: Schema.Json) => Promise<Schema.Json>
  /** Structured text report hook used by tests as an ordering barrier. */
  report?: (event: string) => void
}

export type SupervisorPhase = "starting" | "ready" | "closing" | "exited"

/** One supervised worker generation (one identity.runtime). */
export interface SupervisedWorker {
  /** OS pid of the worker root, for diagnostics only — never used as a fence. */
  readonly pid: number | undefined
  phase(): SupervisorPhase
  /** Root-exit observation of this generation. */
  readonly exited: Promise<RootExit>
  ready(): Promise<void>
  request(method: string, value: Schema.Json, signal?: AbortSignal): Promise<Schema.Json>
  notify(method: string, value: Schema.Json): void
  stop(): Promise<StopResult>
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Own one already-launched worker generation and fence its JSON requests.
 * Always dispose, including after readiness failure. Migrated from the
 * prototype `superviseExecution`; the T5.1 extensions on top are the `init`
 * handshake after `hello`, the `host.call` reverse channel and `notify`.
 * @param options Exact admitted identity, owned transport, explicit budgets and hooks.
 * @returns Supervisor whose stop closes admission synchronously and reports root exit separately from tree proof.
 */
export function superviseWorker(options: {
  extension: string
  identity: RuntimeIdentity
  transport: WorkerTransport
  limits: SupervisorLimits
  hooks?: SupervisorHooks
}): SupervisedWorker {
  const { identity, transport, limits, hooks } = options
  for (const [key, value] of Object.entries(limits))
    if (key !== "restartBackoffMs" && (!Number.isSafeInteger(value) || (value as number) <= 0))
      throw new RangeError("Supervisor budgets must be positive safe integers")
  const started = Date.now()
  const ready = deferred<Completion>()
  const drained = deferred<Completion>()
  const disposed = deferred<Completion>()
  const envelope = { version: PROTOCOL_VERSION, identity } as const
  const pending = new Map<
    typeof RequestID.Type,
    { resolve: (value: Schema.Json) => void; reject: (error: HostProcessError) => void; removeAbort: () => void }
  >()
  let phase: SupervisorPhase = "starting"
  let hello = false
  let drainSent = false
  let disposeSent = false
  let disposeAcknowledged = false
  let rootExit: RootExit | undefined
  let stopping: Promise<StopResult> | undefined
  let fatal: HostProcessError | undefined
  const detail = (frame: string) => ({
    extension: options.extension,
    runtime: "process" as const,
    gen: identity.generation,
    epoch: identity.epoch,
    frame,
    pid: transport.pid,
    elapsedMs: Date.now() - started,
  })
  const report = (event: string) => {
    log.debug("extension host process", detail(event))
    hooks?.report?.(`extension.host-process extension=${options.extension} runtime=${identity.runtime} epoch=${identity.epoch} ${event}`)
  }
  const rejectPending = (error: HostProcessError) => {
    for (const request of pending.values()) {
      request.removeAbort()
      request.reject(error)
    }
    pending.clear()
  }
  const send = (command: Parameters<WorkerTransport["send"]>[0]) => transport.send(command)
  function fail(error: HostProcessError) {
    fatal ??= error
    if (phase !== "exited") phase = "closing"
    ready.resolve({ ok: false, error })
    drained.resolve({ ok: false, error })
    disposed.resolve({ ok: false, error })
    rejectPending(error)
    report(`failed code=${error.code}`)
    log.error("extension host process", { ...detail("failure"), error: `${error.code} ${error.detail ?? ""}`.trim() })
    try {
      transport.terminate()
    } catch (cause) {
      report(`termination-failed code=${cause instanceof HostProcessError ? cause.code : "transport"}`)
    }
  }
  const unsubscribe = transport.subscribe(
    (input) => {
      let event: WorkerEvent
      try {
        event = decodeWorkerEvent(input)
      } catch (cause) {
        fail(cause instanceof HostProcessError ? cause : new HostProcessError({ code: "protocol", cause }))
        return
      }
      if (!sameRuntime(identity, event.identity)) {
        report("discarded-foreign-fence")
        return
      }
      switch (event.type) {
        case "hello":
          if (hello) return fail(new HostProcessError({ code: "protocol", detail: "duplicate hello" }))
          hello = true
          report("hello")
          try {
            // The load contract is delivered after hello; a transport failure
            // here is fatal because the worker would wait for init forever.
            send({ ...envelope, type: "init", value: hooks?.init ?? null })
          } catch (cause) {
            fail(new HostProcessError({ code: "transport", cause }))
          }
          return
        case "ready":
          if (phase === "closing" || phase === "exited") {
            report("discarded-late-ready")
            return
          }
          if (!hello || phase !== "starting") return fail(new HostProcessError({ code: "protocol", detail: "unexpected ready" }))
          phase = "ready"
          ready.resolve({ ok: true })
          report("ready")
          return
        case "drained":
          if (phase !== "closing" || !drainSent) return fail(new HostProcessError({ code: "protocol", detail: "unsolicited drained" }))
          drained.resolve({ ok: true })
          report("drained")
          return
        case "disposed":
          if (phase !== "closing" || !disposeSent) return fail(new HostProcessError({ code: "protocol", detail: "unsolicited disposed" }))
          disposeAcknowledged = true
          disposed.resolve({ ok: true })
          report("disposed")
          return
        case "failed":
          report(`worker-failed phase=${event.phase}`)
          if (event.phase === "dispose" && disposeSent) {
            disposed.resolve({ ok: false, error: new HostProcessError({ code: "requestFailed" }) })
            return
          }
          fail(new HostProcessError({ code: event.phase === "readiness" ? "readiness" : "protocol" }))
          return
        case "result":
        case "rejected": {
          const request = pending.get(event.requestId)
          if (!request || phase !== "ready") {
            report("discarded-late-result")
            return
          }
          pending.delete(event.requestId)
          request.removeAbort()
          if (event.type === "result") request.resolve(event.value)
          else request.reject(new HostProcessError({ code: event.code, detail: event.message }))
          return
        }
        case "host.call": {
          const reply = (command: Parameters<WorkerTransport["send"]>[0]) => {
            try {
              send(command)
            } catch (cause) {
              if (cause instanceof HostProcessError && cause.code === "capacity") {
                report("host-reply-dropped code=capacity")
                return
              }
              fail(new HostProcessError({ code: "transport", cause }))
            }
          }
          const handler = hooks?.onHostCall
          if (!handler) {
            reply({ ...envelope, type: "host.rejected", callId: event.callId, code: "denied", message: "host.call unsupported" })
            return
          }
          void handler(event.method, event.value).then(
            (value) => reply({ ...envelope, type: "host.result", callId: event.callId, value }),
            (cause) =>
              reply({
                ...envelope,
                type: "host.rejected",
                callId: event.callId,
                code: cause instanceof HostProcessError ? cause.code : "requestFailed",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          )
          return
        }
        case "notify":
          try {
            hooks?.onNotify?.(event.method, event.value)
          } catch (cause) {
            log.error("extension host process", { ...detail("notify"), error: cause })
          }
          return
      }
    },
    (cause) => fail(cause instanceof HostProcessError ? cause : new HostProcessError({ code: "transport", cause })),
  )
  void transport.exited.then((exit) => {
    rootExit = exit
    phase = "exited"
    const error = new HostProcessError({ code: "exited", detail: `code=${exit.code} signal=${exit.signal}` })
    if (!disposeAcknowledged || exit.code !== 0 || exit.signal !== null) fatal ??= error
    ready.resolve({ ok: false, error })
    drained.resolve({ ok: false, error })
    disposed.resolve({ ok: false, error })
    rejectPending(error)
    report(`root-exited code=${String(exit.code)} signal=${String(exit.signal)} tree=unproven`)
  })

  async function finishStop(): Promise<StopResult> {
    const issues: StopIssue[] = []
    let force = false
    let failure = fatal
    if (fatal) issues.push(fatal.code)
    if (!rootExit && !fatal) {
      try {
        drainSent = true
        transport.send({ ...envelope, type: "drain" })
        const result = await within(drained.promise, limits.drainMs)
        if (!result.done) issues.push("drainDeadline")
        if (!rootExit && !fatal) {
          disposeSent = true
          transport.send({ ...envelope, type: "dispose" })
          const result = await within(disposed.promise, limits.disposeMs)
          if (!result.done) {
            issues.push("disposeDeadline")
            force = true
          } else if (!result.value.ok && result.value.error.code !== "exited") issues.push("disposeFailed")
        }
      } catch (cause) {
        failure ??= new HostProcessError({ code: "transport", cause })
        issues.push(cause instanceof HostProcessError ? cause.code : "transport")
      }
    }
    if (!rootExit) {
      const graceful = force ? { done: false as const } : await within(transport.exited, limits.exitMs)
      if (graceful.done) rootExit = graceful.value
      else {
        if (!force) issues.push("exitDeadline")
        report("force-terminate")
        try {
          transport.terminate()
        } catch (cause) {
          failure ??= new HostProcessError({ code: "transport", cause })
          issues.push("terminationFailed")
        }
        const forced = await within(transport.exited, limits.exitMs)
        if (forced.done) rootExit = forced.value
      }
    }
    const retainFatal = () => {
      if (!fatal) return
      failure ??= fatal
      if (!issues.includes(fatal.code)) issues.push(fatal.code)
    }
    retainFatal()
    if (!rootExit) {
      report("stop-unknown tree=unproven")
      return { status: "unknown", tree: "unproven", issues, ...(failure ? { failure } : {}) }
    }
    unsubscribe()
    try {
      await transport.release()
    } catch (cause) {
      failure = new HostProcessError({ code: "transport", cause })
      issues.push("releaseFailed")
      report("release-failed")
    }
    retainFatal()
    return { status: "rootExited", exit: rootExit, tree: "unproven", issues, ...(failure ? { failure } : {}) }
  }
  /** Close local admission before yielding; retry after unknown requires a subsequent OS observation. */
  function stop(): Promise<StopResult> {
    if (stopping) return stopping
    if (phase !== "exited") phase = "closing"
    const error = new HostProcessError({ code: "closed" })
    ready.resolve({ ok: false, error })
    rejectPending(error)
    report("admission-closed")
    stopping = finishStop().then((result) => {
      if (result.status === "unknown") stopping = undefined
      return result
    })
    return stopping
  }
  return {
    pid: transport.pid,
    phase: () => phase,
    exited: transport.exited,
    /** Await hello/readiness. Failure does not transfer cleanup responsibility away from the caller. */
    async ready() {
      const result = await within(ready.promise, limits.readinessMs)
      if (!result.done) {
        fail(new HostProcessError({ code: "readiness" }))
        throw new HostProcessError({ code: "readiness" })
      }
      if (!result.value.ok) throw result.value.error
      if (phase !== "ready") throw new HostProcessError({ code: "closed" })
    },
    /**
     * Send one non-replayed call. Cancellation does not roll back effects already performed by the application.
     * @param method Internal JSON operation name, not an extension-kit proxy capability.
     * @param value JSON payload validated again before serialization.
     * @param signal Optional caller cancellation, propagated to this execution only.
     * @returns Result while locally admitted; callers must recheck the durable epoch before applying host effects.
     */
    request(method: string, value: Schema.Json, signal?: AbortSignal): Promise<Schema.Json> {
      if (phase !== "ready") return Promise.reject(new HostProcessError({ code: "closed" }))
      if (signal?.aborted) return Promise.reject(new HostProcessError({ code: "cancelled" }))
      if (pending.size >= limits.maxPending) return Promise.reject(new HostProcessError({ code: "capacity" }))
      const requestId = Schema.decodeUnknownSync(RequestID)(randomUUID())
      return new Promise<Schema.Json>((resolve, reject) => {
        const cancel = () => {
          pending.delete(requestId)
          signal?.removeEventListener("abort", cancel)
          reject(new HostProcessError({ code: "cancelled" }))
          try {
            transport.send({ ...envelope, type: "cancel", requestId })
          } catch (cause) {
            fail(new HostProcessError({ code: "transport", cause }))
          }
        }
        pending.set(requestId, { resolve, reject, removeAbort: () => signal?.removeEventListener("abort", cancel) })
        signal?.addEventListener("abort", cancel, { once: true })
        try {
          transport.send({ ...envelope, type: "request", requestId, method, value })
        } catch (cause) {
          if (cause instanceof HostProcessError && cause.code === "capacity") {
            pending.get(requestId)?.removeAbort()
            pending.delete(requestId)
            reject(cause)
            report("request-rejected code=capacity")
            return
          }
          fail(new HostProcessError({ code: "transport", cause }))
        }
      })
    },
    /** Fire-and-forget notify; capacity overflow drops the frame rather than killing the worker. */
    notify(method: string, value: Schema.Json) {
      if (phase !== "ready") return
      try {
        transport.send({ ...envelope, type: "notify", method, value })
      } catch (cause) {
        if (cause instanceof HostProcessError && cause.code === "capacity") {
          report("notify-dropped code=capacity")
          return
        }
        fail(new HostProcessError({ code: "transport", cause }))
      }
    },
    stop,
    async [Symbol.asyncDispose]() {
      const result = await stop()
      if (result.status === "unknown") throw new HostProcessError({ code: "deadline" })
      if (result.issues.includes("releaseFailed")) throw result.failure ?? new HostProcessError({ code: "transport" })
    },
  }
}

export type WorkerStatus = "starting" | "ready" | "restarting" | "stopping" | "stopped" | "crashed" | "error"

export interface WorkerInfo {
  readonly extension: string
  readonly status: WorkerStatus
  readonly identity: RuntimeIdentity
  readonly pid: number | undefined
  readonly crashes: number
}

/**
 * Public worker handle for one extension runtime. Promise-based at this
 * boundary so the existing Promise-based `runtime/index.ts` can consume it in
 * T5.3 without an Effect conversion; `HostProcessSupervisor.spawn` itself is
 * scoped so scope release always stops the worker.
 */
export interface Worker {
  readonly extension: string
  info(): WorkerInfo
  ready(): Promise<void>
  request(method: string, value: Schema.Json, signal?: AbortSignal): Promise<Schema.Json>
  notify(method: string, value: Schema.Json): void
  stop(): Promise<StopResult>
  [Symbol.asyncDispose](): Promise<void>
}

export interface SpawnInput {
  readonly extension: string
  /** Durable fence coordinates; `runtime` is re-minted by the service per (re)spawn. */
  readonly fence: { store: string; installation: string; generation: number; epoch: number }
  readonly executable: string
  /** Immutable argv, or a factory receiving the per-generation identity (argv carries the fence to the worker). */
  readonly args: string[] | ((identity: RuntimeIdentity) => string[])
  readonly env?: NodeJS.ProcessEnv
  readonly limits?: Partial<SupervisorLimits>
  /** Crash restart skeleton enabled by default; set false to fail fast (design §5). */
  readonly restart?: boolean
  readonly hooks?: SupervisorHooks & {
    onCrash?: (exit: RootExit) => void
    onReady?: () => void
    onExhausted?: (exit: RootExit | undefined) => void
  }
  /** Transport factory override for tests; defaults to a real child process. */
  readonly spawnTransport?: (identity: RuntimeIdentity) => Promise<WorkerTransport>
}

export interface Interface {
  /** Spawn and supervise one worker; releasing the returned scope stops it. */
  spawn(input: SpawnInput): Effect.Effect<Worker, HostProcessError, Scope.Scope>
  workers(): Effect.Effect<WorkerInfo[]>
  readonly testing: {
    /** Adjust service-level default limits; later spawns and restarts pick them up. */
    setLimits(next?: Partial<SupervisorLimits>): void
    /** Stop every live worker and restore default limits. */
    reset(): Effect.Effect<void>
  }
}

/**
 * Host-process supervisor (T5.1). Per-service state lives in the layer closure
 * (the Service 惯例 for process-wide state — there is no per-directory
 * dimension here, so InstanceState is intentionally not used). One record per
 * spawned worker runtime; each record may cycle through several generations
 * (one transport + engine per `identity.runtime`) under the restart backoff.
 */
export class HostProcessSupervisor extends Context.Service<
  HostProcessSupervisor,
  Interface
>()("@opencode/HostProcessSupervisor") {
  static layer = Layer.effect(
    HostProcessSupervisor,
    Effect.gen(function* () {
      const records = new Set<Record>()
      let defaults: SupervisorLimits = DEFAULT_LIMITS
      type Record = {
        input: SpawnInput
        limits: SupervisorLimits
        identity: RuntimeIdentity
        engine: SupervisedWorker | undefined
        status: WorkerStatus
        crashes: number
        stopping: boolean
        stopPromise: Promise<StopResult> | undefined
        timer: ReturnType<typeof setTimeout> | undefined
        started: number
      }

      const detail = (record: Record, pid?: number) => ({
        extension: record.input.extension,
        runtime: "process" as const,
        gen: record.identity.generation,
        epoch: record.identity.epoch,
        pid: pid ?? record.engine?.pid,
        elapsedMs: Date.now() - record.started,
      })

      const launch = async (record: Record): Promise<void> => {
        const identity = record.identity
        // The log callback can fire during spawn diagnostics, before `transport` is assigned.
        let spawnedPid: number | undefined
        const transport = record.input.spawnTransport
          ? await record.input.spawnTransport(identity)
          : await spawnWorkerTransport({
              executable: record.input.executable,
              args: typeof record.input.args === "function" ? record.input.args(identity) : record.input.args,
              env: record.input.env,
              frameBytes: record.limits.frameBytes,
              bufferedFrames: record.limits.bufferedFrames,
              exitMs: record.limits.exitMs,
              log: (stream, text) => {
                const emit = stream === "stderr" ? log.error : log.debug
                emit("extension host process output", {
                  extension: record.input.extension,
                  runtime: "process",
                  gen: identity.generation,
                  epoch: identity.epoch,
                  pid: spawnedPid,
                  stream,
                  text: text.replace(/\n$/, ""),
                })
                record.input.hooks?.report?.(`${stream}: ${text.replace(/\n$/, "")}`)
              },
            })
        spawnedPid = transport.pid
        let engine: SupervisedWorker
        try {
          engine = superviseWorker({
            extension: record.input.extension,
            identity,
            transport,
            limits: record.limits,
            hooks: record.input.hooks,
          })
        } catch (cause) {
          // Engine construction failure (e.g. invalid limits) must not leak the child.
          try {
            transport.terminate()
          } finally {
            await transport.exited.catch(() => {})
            await transport.release().catch(() => {})
          }
          throw cause
        }
        record.engine = engine
        engine.ready().then(
          () => {
            if (record.engine !== engine || record.stopping) return
            record.status = "ready"
            record.input.hooks?.onReady?.()
          },
          () => {},
        )
        void transport.exited.then((exit) => onExit(record, engine, exit))
      }

      const onExit = (record: Record, engine: SupervisedWorker, exit: RootExit) => {
        if (record.engine !== engine || record.stopping) return
        // Release this generation's control pipes before scheduling anything.
        void engine.stop()
        record.crashes++
        log.error("extension host process crashed", { ...detail(record), code: exit.code, signal: exit.signal, crashes: record.crashes })
        record.input.hooks?.onCrash?.(exit)
        const backoffs = record.limits.restartBackoffMs
        if (record.input.restart === false || record.crashes > backoffs.length) {
          record.status = "error"
          record.input.hooks?.onExhausted?.(exit)
          return
        }
        record.status = "restarting"
        const delay = backoffs[record.crashes - 1]!
        log.info("extension host process restart scheduled", { ...detail(record), attempt: record.crashes, delayMs: delay })
        record.timer = setTimeout(() => {
          record.timer = undefined
          if (record.stopping) return
          // A new runtime fence: frames from the dead generation can never
          // resolve work on the restarted worker.
          record.identity = makeIdentity(record.input.fence)
          record.status = "starting"
          void launch(record).catch((cause) => {
            log.error("extension host process restart failed", { ...detail(record), error: cause })
            record.status = "error"
            record.input.hooks?.onExhausted?.(undefined)
          })
        }, delay)
        record.timer.unref?.()
      }

      const stop = (record: Record): Promise<StopResult> => {
        if (record.stopPromise) return record.stopPromise
        record.stopping = true
        if (record.status !== "error" && record.status !== "stopped") record.status = "stopping"
        if (record.timer) clearTimeout(record.timer)
        record.timer = undefined
        record.stopPromise = (async () => {
          const result = record.engine
            ? await record.engine.stop()
            : ({ status: "unknown", tree: "unproven", issues: [] } as StopResult)
          if (result.status === "unknown") {
            // Exit could not be proven; a later OS observation permits retry.
            record.stopPromise = undefined
            return result
          }
          record.status = "stopped"
          records.delete(record)
          return result
        })()
        return record.stopPromise
      }

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.allSettled([...records].map((record) => stop(record)))).pipe(Effect.asVoid),
      )

      return HostProcessSupervisor.of({
        spawn: (input) =>
          Effect.acquireRelease(
            Effect.tryPromise({
              try: async (): Promise<Record> => {
                const limits = { ...defaults, ...input.limits }
                const record: Record = {
                  input,
                  limits,
                  identity: makeIdentity(input.fence),
                  engine: undefined,
                  status: "starting",
                  crashes: 0,
                  stopping: false,
                  stopPromise: undefined,
                  timer: undefined,
                  started: Date.now(),
                }
                records.add(record)
                try {
                  await launch(record)
                } catch (cause) {
                  records.delete(record)
                  throw cause
                }
                return record
              },
              catch: (cause) =>
                cause instanceof HostProcessError ? cause : new HostProcessError({ code: "transport", cause }),
            }),
            (record) => Effect.promise(() => stop(record)).pipe(Effect.ignore),
          ).pipe(
            Effect.map((record): Worker => {
              const worker: Worker = {
                extension: input.extension,
                info: () => ({
                  extension: input.extension,
                  status: record.status,
                  identity: record.identity,
                  pid: record.engine?.pid,
                  crashes: record.crashes,
                }),
                ready: () =>
                  record.engine?.ready() ??
                  Promise.reject(new HostProcessError({ code: "closed" })),
                request: (method, value, signal) =>
                  record.engine
                    ? record.engine.request(method, value, signal)
                    : Promise.reject(new HostProcessError({ code: "closed" })),
                notify: (method, value) => record.engine?.notify(method, value),
                stop: () => stop(record),
                async [Symbol.asyncDispose]() {
                  const result = await worker.stop()
                  if (result.status === "unknown") throw new HostProcessError({ code: "deadline" })
                  if (result.issues.includes("releaseFailed"))
                    throw result.failure ?? new HostProcessError({ code: "transport" })
                },
              }
              return worker
            }),
          ),
        workers: () => Effect.sync(() => [...records].map((record) => ({
          extension: record.input.extension,
          status: record.status,
          identity: record.identity,
          pid: record.engine?.pid,
          crashes: record.crashes,
        }))),
        testing: {
          setLimits: (next) => {
            defaults = { ...DEFAULT_LIMITS, ...next }
          },
          reset: () =>
            Effect.sync(() => {
              defaults = DEFAULT_LIMITS
            }).pipe(
              Effect.andThen(
                Effect.promise(() => Promise.allSettled([...records].map((record) => stop(record)))),
              ),
              Effect.asVoid,
            ),
        },
      })
    }),
  )
}

export * as HostProcess from "./supervisor.ts"
