import { createReadStream, createWriteStream } from "node:fs"
import { Socket } from "node:net"
import type { Readable, Writable } from "node:stream"
import { Schema } from "effect"
import {
  decodeExecutionCommand,
  decodeExecutionEvent,
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionEvent,
  type RequestID,
} from "./execution-protocol.ts"
import { sameRuntime, type RuntimeIdentity } from "./lifecycle-state.ts"
import { closeExecutionPipes, readControlFrames } from "./execution-process.ts"

/** Internal JSON-only application seam. This does not implement the extension-kit author API. */
export interface ExecutionApplication {
  request(method: string, value: Schema.Json, signal: AbortSignal): Promise<Schema.Json>
  dispose(): Promise<void>
}
/** Worker-side channel; fd3/fd4 are reserved for supervisor traffic, not extension stdout. */
export interface WorkerChannel {
  send(event: ExecutionEvent): Promise<void>
  listen(message: (input: unknown) => void, failure: (error: Error) => void, disconnected: () => void): () => void
}

/**
 * Open the dedicated control descriptors established by spawnExecutionProcess.
 * @param frameBytes Maximum bytes per incoming or outgoing protocol frame.
 * @returns Worker channel; its disposer closes both owned descriptors.
 */
export function openWorkerChannel(frameBytes: number): WorkerChannel & AsyncDisposable {
  if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0)
    throw new RangeError("Execution frame budget must be positive")
  // Node needs pollable socket handles; Bun uses its descriptor stream implementation.
  const input: Readable = process.versions.bun
    ? createReadStream("", { fd: 3 })
    : new Socket({ fd: 3, readable: true, writable: false })
  const output: Writable = process.versions.bun
    ? createWriteStream("", { fd: 4 })
    : new Socket({ fd: 4, readable: false, writable: true })
  let ioFailure: Error | undefined
  const remember = (error: Error) => {
    ioFailure ??= error
  }
  input.on("error", remember)
  output.on("error", remember)
  return {
    send(event) {
      const frame = JSON.stringify(decodeExecutionEvent(event))
      if (Buffer.byteLength(frame) > frameBytes)
        return Promise.reject(new Error("Execution event exceeds frame budget"))
      return new Promise<void>((resolve, reject) =>
        output.write(`${frame}\n`, (error) => (error ? reject(error) : resolve())),
      )
    },
    listen(message, failure, disconnected) {
      const remove = readControlFrames(input, frameBytes, message, failure)
      input.once("end", disconnected)
      output.on("error", failure)
      if (ioFailure) failure(ioFailure)
      return () => {
        remove()
        input.off("end", disconnected)
        output.off("error", failure)
      }
    },
    async [Symbol.asyncDispose]() {
      await closeExecutionPipes([input, output], remember)
    },
  }
}

/**
 * Serve one admitted identity. The caller must hold its shared OS reference before loading any application code.
 * @param options Identity, control channel, cancellable loader, request budget and nonthrowing diagnostics.
 * @returns Disposal/readiness outcome. The entrypoint must retain its OS reference until actual process exit, not release it on this acknowledgement.
 */
export async function serveExecution(options: {
  identity: RuntimeIdentity
  channel: WorkerChannel
  load: (signal: AbortSignal) => Promise<ExecutionApplication>
  maxRequests: number
  report: (event: string) => void
  disconnect: () => never
}): Promise<"disposed" | "failed"> {
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests <= 0)
    throw new RangeError("Execution request budget must be positive")
  const { identity, channel, report } = options
  const envelope = { version: EXECUTION_PROTOCOL_VERSION, identity } as const
  const active = new Map<typeof RequestID.Type, { abort: AbortController; done: Promise<void> }>()
  const loading = new AbortController()
  let closed = false
  let ready = false
  let disposing: Promise<void> | undefined
  let complete!: (outcome: "disposed" | "failed") => void
  const done = new Promise<"disposed" | "failed">((resolve) => {
    complete = resolve
  })
  const log = (event: string) => report(`extension.worker pid=${process.pid} runtime=${identity.runtimeId} ${event}`)
  const errorFields = (cause: unknown) => {
    const error = cause as { code?: unknown; path?: unknown; cause?: { code?: unknown } } | undefined
    return `code=${String(error?.code ?? "none")} path=${String(error?.path ?? "none")} cause=${String(error?.cause?.code ?? "none")}`
  }
  const closeAdmission = () => {
    closed = true
    ready = false
    loading.abort()
    for (const request of active.values()) request.abort.abort()
  }
  const disconnected = () => {
    closeAdmission()
    log("control-disconnected")
    options.disconnect()
  }
  const run = (task: Promise<void>) => {
    void task.catch((cause) => {
      log(`control-failed stage=channel ${errorFields(cause)}`)
      disconnected()
    })
  }
  const application = (async () => {
    await channel.send({ ...envelope, type: "hello" })
    try {
      const app = await options.load(loading.signal)
      if (!closed) {
        ready = true
        await channel.send({ ...envelope, type: "ready" })
      }
      log(closed ? "loaded-after-close" : "ready")
      return app
    } catch (cause) {
      closeAdmission()
      await channel.send({ ...envelope, type: "failed", phase: "readiness" })
      complete("failed")
      return undefined
    }
  })()
  run(application.then(() => {}))
  const remove = channel.listen(
    (input) => {
      let command
      try {
        command = decodeExecutionCommand(input)
      } catch (cause) {
        log("invalid-command")
        disconnected()
        return
      }
      if (!sameRuntime(identity, command.identity)) {
        log("discarded-foreign-fence")
        return
      }
      switch (command.type) {
        case "request": {
          if (closed || !ready || active.size >= options.maxRequests) {
            run(
              channel.send({
                ...envelope,
                type: "rejected",
                requestId: command.requestId,
                code: closed || !ready ? "closed" : "capacity",
              }),
            )
            return
          }
          if (active.has(command.requestId)) {
            log("duplicate-request")
            disconnected()
            return
          }
          const abort = new AbortController()
          const task = (async () => {
            try {
              const app = await application
              if (!app || closed) return
              const value = await app.request(command.method, command.value, abort.signal)
              if (closed) {
                log("discarded-late-result")
                return
              }
              if (abort.signal.aborted)
                await channel.send({ ...envelope, type: "rejected", requestId: command.requestId, code: "cancelled" })
              else await channel.send({ ...envelope, type: "result", requestId: command.requestId, value })
            } catch (cause) {
              if (!closed)
                await channel.send({
                  ...envelope,
                  type: "rejected",
                  requestId: command.requestId,
                  code: abort.signal.aborted ? "cancelled" : "requestFailed",
                })
            }
          })().finally(() => active.delete(command.requestId))
          active.set(command.requestId, { abort, done: task })
          run(task)
          return
        }
        case "cancel":
          active.get(command.requestId)?.abort.abort()
          return
        case "drain":
          closeAdmission()
          log("draining")
          run(
            Promise.allSettled([...active.values()].map((request) => request.done)).then(() =>
              channel.send({ ...envelope, type: "drained" }),
            ),
          )
          return
        case "dispose":
          closeAdmission()
          disposing ??= (async () => {
            const app = await application
            try {
              await app?.dispose()
            } catch (cause) {
              log("dispose-failed")
              await channel.send({ ...envelope, type: "failed", phase: "dispose" })
              complete("failed")
              return
            }
            await channel.send({ ...envelope, type: "disposed" })
            log("disposed")
            complete("disposed")
          })()
          run(disposing)
          return
      }
    },
    (cause) => {
      log(`control-failed stage=channel ${errorFields(cause)}`)
      disconnected()
    },
    disconnected,
  )
  try {
    return await done
  } finally {
    remove()
  }
}

export * as ExecutionWorker from "./execution-worker.ts"
