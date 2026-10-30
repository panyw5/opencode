import { Effect, Exit, Schema, Semaphore } from "effect"
import { Worker } from "node:worker_threads"
import * as Log from "@opencode-ai/core/util/log"
import { load, normalize as inProcess, type Limits, type Photon, type Result } from "./photon-normalize"
import type { Reply, Request } from "./photon-worker"

const log = Log.create({ service: "image.worker" })

export class UnavailableError extends Schema.TaggedErrorClass<UnavailableError>()("ImageWorkerUnavailableError", {}) {}

export const spawnWorker = (
  url = new URL(import.meta.url.endsWith(".ts") ? "./photon-worker.ts" : "./photon-worker.js", import.meta.url),
) =>
  Effect.tryPromise({
    try: async (signal) => {
      log.info("starting image worker")
      const worker = new Worker(url)
      const abort = () => {
        void worker.terminate()
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      try {
        await new Promise<void>((resolve, reject) => {
          const ready = (reply: Reply) => {
            if (reply?.type !== "ready") return
            cleanup()
            resolve()
          }
          const fail = (error: Error) => {
            cleanup()
            reject(error)
          }
          const exit = (code: number) => fail(new Error(`Image worker exited before ready: ${code}`))
          const cleanup = () => {
            worker.off("message", ready).off("error", fail).off("exit", exit)
          }
          worker.on("message", ready).once("error", fail).once("exit", exit)
        })
        log.info("image worker ready")
        return worker
      } catch (error) {
        log.warn("image worker startup failed", {
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        })
        void worker.terminate()
        throw error
      } finally {
        signal.removeEventListener("abort", abort)
      }
    },
    catch: () => new UnavailableError(),
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(() => new UnavailableError()),
  )

export function makeWith(spawn: Effect.Effect<Worker, UnavailableError>, idleMillis = 10_000) {
  const permit = Semaphore.makeUnsafe(1)
  let current: Worker | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let fallback = false
  let photon: Promise<Photon> | undefined

  const discard = (worker: Worker) => {
    if (current === worker) current = undefined
    log.info("discarding image worker")
    void worker.terminate()
  }
  const request = (worker: Worker, base64: string, limits: Limits) =>
    Effect.callback<Result>((resume) => {
      const cleanup = () => {
        worker.off("message", reply).off("error", fail).off("messageerror", fail).off("exit", exit)
        worker.unref()
      }
      const reply = (reply: Reply) => {
        if (reply?.type !== "done") return
        cleanup()
        log.info("image worker request completed", { result: reply.result.type })
        resume(Effect.succeed(reply.result))
      }
      const fail = () => {
        cleanup()
        log.warn("image worker request failed")
        resume(Effect.succeed({ type: "decode-error" }))
        discard(worker)
      }
      const exit = () => fail()
      worker.on("message", reply).on("error", fail).on("messageerror", fail).on("exit", exit)
      worker.ref()
      worker.postMessage({ base64, limits } satisfies Request)
      return Effect.sync(cleanup)
    })

  return (base64: string, limits: Limits) =>
    Effect.gen(function* () {
      if (!fallback) {
        const result = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            clearTimeout(idle)
            const worker = current ?? (yield* restore(spawn))
            if (!current) {
              current = worker
              worker.unref()
              const forget = () => {
                if (current === worker) current = undefined
              }
              worker.on("error", forget).once("exit", forget)
            }
            return yield* restore(request(worker, base64, limits)).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) return discard(worker)
                  if (current !== worker) return
                  idle = setTimeout(() => discard(worker), idleMillis)
                  idle.unref()
                }),
              ),
            )
          }),
        ).pipe(Effect.result)
        if (result._tag === "Success") return result.success
        fallback = true
        log.warn("image worker unavailable, using in-process resize")
      }
      const loaded = yield* Effect.tryPromise({
        try: () =>
          (photon ??= load().catch((error) => {
            photon = undefined
            throw error
          })),
        catch: () => new UnavailableError(),
      })
      return inProcess(loaded, base64, limits)
    }).pipe(permit.withPermits(1))
}

// Shared by every project. Terminating the idle worker releases the WASM heap.
export const normalize = makeWith(spawnWorker())
