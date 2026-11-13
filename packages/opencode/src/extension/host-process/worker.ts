import { randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { Socket } from "node:net"
import type { Readable, Writable } from "node:stream"
import { Schema } from "effect"
import {
  type CallID,
  decodeHostCommand,
  HostProcessError,
  type HostCommand,
  PROTOCOL_VERSION,
  type RejectionCode,
  type RequestID,
  type RuntimeIdentity,
  sameRuntime,
  serializeEvent,
  type WorkerEvent,
} from "./protocol.ts"
import { closeControlPipes, readControlFrames } from "./transport.ts"

/**
 * Worker-side endpoint of the host-process protocol (T5.1 skeleton). The real
 * extension loader, host API proxies and `input.client` plumbing land in T5.2;
 * this file already implements the full lifecycle chain (hello → init → ready
 * → request/cancel/notify → drain → dispose → exit) plus the host.call
 * reverse channel so T5.1 can be tested end-to-end.
 *
 * fd ownership: fd3 is host → worker commands, fd4 is worker → host events.
 * EOF on fd3 means the host control channel is gone; the worker must exit so
 * a crashed host never leaves an orphan holding extension state.
 */
export interface WorkerChannel {
  /** Validate and write one event frame; resolves once the frame is flushed. */
  send(event: WorkerEvent): Promise<void>
  listen(
    message: (value: unknown) => void,
    failure: (error: Error) => void,
    disconnected: () => void,
  ): () => void
  close(): Promise<void>
}

/**
 * Open the worker control channel on fd3/fd4. Under Bun the descriptor is a
 * native socket duplicated by `transport-bun.ts`; `fs.createReadStream` adopts
 * it. Under Node, `net.Socket` adopts the inherited fd.
 */
export function openWorkerChannel(options: { frameBytes: number }): WorkerChannel & AsyncDisposable {
  const bun = typeof process.versions.bun === "string"
  const input: Readable = bun
    ? createReadStream("", { fd: 3, autoClose: false })
    : new Socket({ fd: 3, readable: true, writable: false, allowHalfOpen: true })
  const output: Writable = bun
    ? createWriteStream("", { fd: 4, autoClose: false })
    : new Socket({ fd: 4, readable: false, writable: true })
  const pipeError = () => {}
  input.on("error", pipeError)
  output.on("error", pipeError)
  return {
    send(event) {
      const frame = serializeEvent(event)
      return new Promise<void>((resolve, reject) => {
        output.write(`${frame}\n`, (error) =>
          error ? reject(new HostProcessError({ code: "transport", cause: error })) : resolve(),
        )
      })
    },
    listen(message, failure, disconnected) {
      let ended = false
      const disconnect = () => {
        if (ended) return
        ended = true
        disconnected()
      }
      input.on("end", disconnect)
      input.on("close", disconnect)
      const remove = readControlFrames(input, options.frameBytes, message, failure)
      return () => {
        remove()
        input.off("end", disconnect)
        input.off("close", disconnect)
      }
    },
    async close() {
      await closeControlPipes([input, output], pipeError)
    },
    async [Symbol.asyncDispose]() {
      await this.close()
    },
  }
}

/** What the extension loader hands to the worker runtime (T5.2 fills this in). */
export interface WorkerApplication {
  request(method: string, value: Schema.Json, signal: AbortSignal): Promise<Schema.Json>
  notify?(method: string, value: Schema.Json): void | Promise<void>
  dispose?(): Promise<void>
}

/** Reverse channel available to the application: host.call requests and notify events. */
export interface WorkerHost {
  call(method: string, value: Schema.Json): Promise<Schema.Json>
  notify(method: string, value: Schema.Json): Promise<void>
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

const knownRejections: readonly RejectionCode[] = ["closed", "cancelled", "requestFailed", "capacity", "denied"]

/**
 * Serve one extension worker generation on `channel`. Resolves `"disposed"`
 * after a clean dispose handshake, `"failed"` after readiness/protocol failure
 * or control-channel loss (when no `disconnect` callback exits first).
 */
export async function serveWorker(options: {
  identity: RuntimeIdentity
  channel: WorkerChannel
  /** Extension loader; receives the host's `init` payload and the abort signal for readiness. */
  load: (init: Schema.Json, host: WorkerHost, signal: AbortSignal) => Promise<WorkerApplication>
  maxRequests?: number
  report?: (event: string) => void
  /** Called on control-channel loss so the caller can exit the process. */
  disconnect?: () => void
}): Promise<"disposed" | "failed"> {
  const maxRequests = options.maxRequests ?? 32
  const channel = options.channel
  const envelope = { version: PROTOCOL_VERSION, identity: options.identity } as const
  const report = options.report ?? (() => {})
  const pending = new Map<string, AbortController>()
  const inflight = new Set<Promise<unknown>>()
  const calls = new Map<string, { resolve: (value: Schema.Json) => void; reject: (cause: unknown) => void }>()
  const completed = deferred<"disposed" | "failed">()
  const initWait = deferred<{ ok: boolean; value: Schema.Json }>()
  const loading = new AbortController()
  let closed = false
  let ready = false
  let initReceived = false
  let disconnected = false
  let app: WorkerApplication | undefined
  let disposeStarted = false

  const send = (event: WorkerEvent) =>
    channel.send(event).catch(() => {
      // A dead control channel terminates the worker; the completion path
      // (disconnect callback or channel failure) handles it.
    })

  const rejectRequest = (requestId: typeof RequestID.Type, code: RejectionCode, message?: string) =>
    send({ ...envelope, type: "rejected", requestId, code, message })

  const closeAdmission = () => {
    if (closed) return
    closed = true
    loading.abort()
    if (!initReceived) initWait.resolve({ ok: false, value: null })
    for (const [requestId, controller] of pending) {
      controller.abort()
      pending.delete(requestId)
      void rejectRequest(requestId as typeof RequestID.Type, "closed")
    }
    for (const [callId, call] of calls) {
      calls.delete(callId)
      call.reject(new HostProcessError({ code: "closed" }))
    }
  }

  const failProtocol = (detail: string) => {
    report(`protocol-failure ${detail}`)
    closeAdmission()
    // Flush the failed frame before the caller may close the channel.
    void send({ ...envelope, type: "failed", phase: "protocol" }).finally(() => completed.resolve("failed"))
  }

  const host: WorkerHost = {
    call(method, value) {
      if (closed) return Promise.reject(new HostProcessError({ code: "closed" }))
      const callId = randomUUID() as typeof CallID.Type
      return new Promise<Schema.Json>((resolve, reject) => {
        calls.set(callId, { resolve, reject })
        try {
          void send({ ...envelope, type: "host.call", callId, method, value })
        } catch (cause) {
          calls.delete(callId)
          reject(cause)
        }
      })
    },
    notify(method, value) {
      if (closed) return Promise.reject(new HostProcessError({ code: "closed" }))
      return channel.send({ ...envelope, type: "notify", method, value })
    },
  }

  const dispatch = (input: unknown) => {
    let command: HostCommand
    try {
      command = decodeHostCommand(input)
    } catch {
      return failProtocol("malformed-command")
    }
    if (!sameRuntime(command.identity, options.identity)) {
      report("discarded-foreign-frame")
      return
    }
    switch (command.type) {
      case "init":
        if (initReceived) return failProtocol("duplicate-init")
        initReceived = true
        initWait.resolve({ ok: true, value: command.value })
        return
      case "request": {
        if (closed || !ready || !app) return void rejectRequest(command.requestId, "closed")
        if (pending.size >= maxRequests) return void rejectRequest(command.requestId, "capacity")
        const controller = new AbortController()
        pending.set(command.requestId, controller)
        const task = Promise.resolve(app.request(command.method, command.value, controller.signal))
        inflight.add(task)
        // finally() would propagate the rejection into an unobserved chain.
        void task.then(
          () => inflight.delete(task),
          () => inflight.delete(task),
        )
        void task.then(
          (value) => {
            if (!pending.delete(command.requestId)) return
            try {
              void send({ ...envelope, type: "result", requestId: command.requestId, value })
            } catch {
              // An unserializable result is an application defect, not a host failure.
              void rejectRequest(command.requestId, "requestFailed", "result is not JSON")
            }
          },
          (cause) => {
            if (!pending.delete(command.requestId)) return
            if (controller.signal.aborted) return void rejectRequest(command.requestId, "cancelled")
            void rejectRequest(
              command.requestId,
              cause instanceof HostProcessError && (knownRejections as readonly string[]).includes(cause.code)
                ? (cause.code as RejectionCode)
                : "requestFailed",
              cause instanceof Error ? cause.message : String(cause),
            )
          },
        )
        return
      }
      case "cancel": {
        const controller = pending.get(command.requestId)
        if (!controller) return
        pending.delete(command.requestId)
        controller.abort()
        void rejectRequest(command.requestId, "cancelled")
        return
      }
      case "notify":
        if (closed || !ready) return
        void Promise.resolve(app?.notify?.(command.method, command.value)).catch((cause) =>
          report(`notify-failure ${cause instanceof Error ? cause.message : String(cause)}`),
        )
        return
      case "host.result": {
        const call = calls.get(command.callId)
        if (!call) return
        calls.delete(command.callId)
        call.resolve(command.value)
        return
      }
      case "host.rejected": {
        const call = calls.get(command.callId)
        if (!call) return
        calls.delete(command.callId)
        const code = (knownRejections as readonly string[]).includes(command.code)
          ? (command.code as RejectionCode)
          : "requestFailed"
        call.reject(new HostProcessError({ code, detail: command.message }))
        return
      }
      case "drain":
        closeAdmission()
        // Drain admits no new work but waits for in-flight requests to settle;
        // a request that ignores abort therefore produces drainDeadline host-side.
        void (async () => {
          await Promise.allSettled(inflight)
          await send({ ...envelope, type: "drained" })
        })()
        return
      case "dispose": {
        if (disposeStarted) return
        disposeStarted = true
        closeAdmission()
        void (async () => {
          try {
            await app?.dispose?.()
            await send({ ...envelope, type: "disposed" })
            completed.resolve("disposed")
          } catch {
            await send({ ...envelope, type: "failed", phase: "dispose" })
            completed.resolve("failed")
          }
        })()
        return
      }
    }
  }

  const disconnectedChannel = () => {
    if (disconnected) return
    disconnected = true
    report("disconnected")
    closeAdmission()
    if (options.disconnect) return options.disconnect()
    completed.resolve("failed")
  }

  // Attach the listener before hello so the host's init reply can never land
  // in a window with no receiver.
  const remove = options.channel.listen(dispatch, () => disconnectedChannel(), () => disconnectedChannel())

  void (async () => {
    try {
      await channel.send({ ...envelope, type: "hello" })
    } catch {
      return disconnectedChannel()
    }
    const init = await initWait.promise
    if (!init.ok || closed) return
    try {
      const loaded = await options.load(init.value, host, loading.signal)
      app = loaded
    } catch {
      if (closed) return
      closeAdmission()
      void send({ ...envelope, type: "failed", phase: "readiness" }).finally(() => completed.resolve("failed"))
      return
    }
    if (closed) {
      report("loaded-after-close")
      return
    }
    ready = true
    report("ready")
    void send({ ...envelope, type: "ready" })
  })()

  const result = await completed.promise
  remove()
  await channel.close().catch(() => {})
  return result
}

export * as HostProcessWorker from "./worker.ts"
