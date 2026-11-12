import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { decodeExecutionEvent, ExecutionError, RequestID, EXECUTION_PROTOCOL_VERSION } from "./execution-protocol.ts"
import { sameRuntime, type RuntimeIdentity } from "./lifecycle-state.ts"
import type { ExecutionTransport, RootExit } from "./execution-process.ts"

/** Explicit deployment budgets; expiry limits waiting and never proves process death. */
export type SupervisorLimits = {
  readinessMs: number
  drainMs: number
  disposeMs: number
  exitMs: number
  maxPending: number
}
/** Failed steps remain visible even when the execution root eventually exits. */
export type StopIssue =
  | ExecutionError["code"]
  | "drainDeadline"
  | "exitDeadline"
  | "disposeDeadline"
  | "disposeFailed"
  | "terminationFailed"
  | "releaseFailed"
/** Root exit alone never authorizes removal of a generation or installation. */
export type StopResult =
  | { status: "rootExited"; exit: RootExit; tree: "unproven"; issues: readonly StopIssue[]; failure?: ExecutionError }
  | { status: "unknown"; tree: "unproven"; issues: readonly StopIssue[]; failure?: ExecutionError }

type Completion = { ok: true } | { ok: false; error: ExecutionError }
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
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Own one already-launched execution and fence its JSON requests. Always dispose, including after readiness failure.
 * @param options Exact admitted identity, owned transport, explicit budgets and a nonthrowing diagnostic sink.
 * @returns Supervisor whose stop closes admission synchronously and reports root exit separately from tree proof.
 */
export function superviseExecution(options: {
  identity: RuntimeIdentity
  transport: ExecutionTransport
  limits: SupervisorLimits
  report: (event: string) => void
}) {
  const { identity, transport, limits, report } = options
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError("Supervisor budgets must be positive safe integers")
  const ready = deferred<Completion>()
  const drained = deferred<Completion>()
  const disposed = deferred<Completion>()
  const envelope = { version: EXECUTION_PROTOCOL_VERSION, identity } as const
  const pending = new Map<
    typeof RequestID.Type,
    { resolve: (value: Schema.Json) => void; reject: (error: ExecutionError) => void; removeAbort: () => void }
  >()
  let phase: "starting" | "ready" | "closing" | "exited" = "starting"
  let hello = false
  let drainSent = false
  let disposeSent = false
  let disposeAcknowledged = false
  let rootExit: RootExit | undefined
  let stopping: Promise<StopResult> | undefined
  let fatal: ExecutionError | undefined
  const log = (event: string) =>
    report(`extension.execution runtime=${identity.runtimeId} epoch=${identity.epoch} ${event}`)
  const rejectPending = (error: ExecutionError) => {
    for (const request of pending.values()) {
      request.removeAbort()
      request.reject(error)
    }
    pending.clear()
  }
  function fail(error: ExecutionError) {
    fatal ??= error
    if (phase !== "exited") phase = "closing"
    ready.resolve({ ok: false, error })
    drained.resolve({ ok: false, error })
    disposed.resolve({ ok: false, error })
    rejectPending(error)
    log(`failed code=${error.code}`)
    try {
      transport.terminate()
    } catch (cause) {
      log(`termination-failed code=${cause instanceof ExecutionError ? cause.code : "transport"}`)
    }
  }
  const unsubscribe = transport.subscribe(
    (input) => {
      let event
      try {
        event = decodeExecutionEvent(input)
      } catch (cause) {
        fail(new ExecutionError("protocol", { cause }))
        return
      }
      if (!sameRuntime(identity, event.identity)) {
        log("discarded-foreign-fence")
        return
      }
      switch (event.type) {
        case "hello":
          if (hello) return fail(new ExecutionError("protocol"))
          hello = true
          log("hello")
          return
        case "ready":
          if (phase === "closing" || phase === "exited") {
            log("discarded-late-ready")
            return
          }
          if (!hello || phase !== "starting") return fail(new ExecutionError("protocol"))
          phase = "ready"
          ready.resolve({ ok: true })
          log("ready")
          return
        case "drained":
          if (phase !== "closing" || !drainSent) return fail(new ExecutionError("protocol"))
          drained.resolve({ ok: true })
          log("drained")
          return
        case "disposed":
          if (phase !== "closing" || !disposeSent) return fail(new ExecutionError("protocol"))
          disposeAcknowledged = true
          disposed.resolve({ ok: true })
          log("disposed")
          return
        case "failed":
          log(`worker-failed phase=${event.phase}`)
          if (event.phase === "dispose" && disposeSent) {
            disposed.resolve({ ok: false, error: new ExecutionError("requestFailed") })
            return
          }
          fail(new ExecutionError(event.phase === "readiness" ? "readiness" : "protocol"))
          return
        case "result":
        case "rejected": {
          const request = pending.get(event.requestId)
          if (!request || phase !== "ready") {
            log("discarded-late-result")
            return
          }
          pending.delete(event.requestId)
          request.removeAbort()
          if (event.type === "result") request.resolve(event.value)
          else request.reject(new ExecutionError(event.code))
          return
        }
      }
    },
    (cause) => fail(new ExecutionError("transport", { cause })),
  )
  void transport.exited.then((exit) => {
    rootExit = exit
    phase = "exited"
    const error = new ExecutionError("exited")
    if (!disposeAcknowledged || exit.code !== 0 || exit.signal !== null) fatal ??= error
    ready.resolve({ ok: false, error })
    drained.resolve({ ok: false, error })
    disposed.resolve({ ok: false, error })
    rejectPending(error)
    log(`root-exited code=${String(exit.code)} signal=${String(exit.signal)} tree=unproven`)
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
        failure ??= new ExecutionError("transport", { cause })
        issues.push(cause instanceof ExecutionError ? cause.code : "transport")
      }
    }
    if (!rootExit) {
      const graceful = force ? { done: false as const } : await within(transport.exited, limits.exitMs)
      if (graceful.done) rootExit = graceful.value
      else {
        if (!force) issues.push("exitDeadline")
        log("force-terminate")
        try {
          transport.terminate()
        } catch (cause) {
          failure ??= new ExecutionError("transport", { cause })
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
      log("stop-unknown tree=unproven")
      return { status: "unknown", tree: "unproven", issues, ...(failure ? { failure } : {}) }
    }
    unsubscribe()
    try {
      await transport.release()
    } catch (cause) {
      failure = new ExecutionError("transport", { cause })
      issues.push("releaseFailed")
      log("release-failed")
    }
    retainFatal()
    return { status: "rootExited", exit: rootExit, tree: "unproven", issues, ...(failure ? { failure } : {}) }
  }
  /** Close local admission before yielding; retry after unknown requires a subsequent OS observation. */
  function stop(): Promise<StopResult> {
    if (stopping) return stopping
    if (phase !== "exited") phase = "closing"
    const error = new ExecutionError("closed")
    ready.resolve({ ok: false, error })
    rejectPending(error)
    log("admission-closed")
    stopping = finishStop().then((result) => {
      if (result.status === "unknown") stopping = undefined
      return result
    })
    return stopping
  }
  return {
    /** Await hello/readiness. Failure does not transfer cleanup responsibility away from the caller. */
    async ready() {
      const result = await within(ready.promise, limits.readinessMs)
      if (!result.done) {
        fail(new ExecutionError("readiness"))
        throw new ExecutionError("readiness")
      }
      if (!result.value.ok) throw result.value.error
      if (phase !== "ready") throw new ExecutionError("closed")
    },
    /**
     * Send one non-replayed call. Cancellation does not roll back effects already performed by the application.
     * @param method Internal JSON operation name, not an extension-kit proxy capability.
     * @param value JSON payload validated again before serialization.
     * @param signal Optional caller cancellation, propagated to this execution only.
     * @returns Result while locally admitted; callers must recheck the durable epoch before applying host effects.
     */
    request(method: string, value: Schema.Json, signal?: AbortSignal): Promise<Schema.Json> {
      if (phase !== "ready") return Promise.reject(new ExecutionError("closed"))
      if (signal?.aborted) return Promise.reject(new ExecutionError("cancelled"))
      if (pending.size >= limits.maxPending) return Promise.reject(new ExecutionError("capacity"))
      const requestId = Schema.decodeUnknownSync(RequestID)(randomUUID())
      return new Promise<Schema.Json>((resolve, reject) => {
        const cancel = () => {
          pending.delete(requestId)
          signal?.removeEventListener("abort", cancel)
          reject(new ExecutionError("cancelled"))
          try {
            transport.send({ ...envelope, type: "cancel", requestId })
          } catch (cause) {
            fail(new ExecutionError("transport", { cause }))
          }
        }
        pending.set(requestId, { resolve, reject, removeAbort: () => signal?.removeEventListener("abort", cancel) })
        signal?.addEventListener("abort", cancel, { once: true })
        try {
          transport.send({ ...envelope, type: "request", requestId, method, value })
        } catch (cause) {
          if (cause instanceof ExecutionError && cause.code === "capacity") {
            pending.get(requestId)?.removeAbort()
            pending.delete(requestId)
            reject(cause)
            log("request-rejected code=capacity")
            return
          }
          fail(new ExecutionError("transport", { cause }))
        }
      })
    },
    stop,
    async [Symbol.asyncDispose]() {
      const result = await stop()
      if (result.status === "unknown") throw new ExecutionError("deadline")
      if (result.issues.includes("releaseFailed")) throw result.failure ?? new ExecutionError("transport")
    },
  }
}

export * as ExecutionSupervisor from "./execution-supervisor.ts"
