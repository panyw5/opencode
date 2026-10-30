import { expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { makeWith, spawnWorker, UnavailableError } from "../../src/image/photon-runtime"
import { testEffect } from "../lib/effect"
import type { Worker } from "node:worker_threads"

const it = testEffect(Layer.empty)
const pixel = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
const limits = { autoResize: true, maxWidth: 2000, maxHeight: 2000, maxBase64Bytes: 5 * 1024 * 1024 }

it.live("image work runs in a worker and its idle WASM heap is released", () =>
  Effect.gen(function* () {
    const workers: Worker[] = []
    const resize = makeWith(spawnWorker().pipe(Effect.tap((worker) => Effect.sync(() => workers.push(worker)))), 20)
    expect(yield* resize(pixel, limits)).toEqual({ type: "unchanged" })
    expect(workers).toHaveLength(1)
    yield* Effect.promise(() => new Promise<void>((resolve) => workers[0].once("exit", () => resolve())))
    expect(workers[0].threadId).toBe(-1)
    expect(yield* resize(pixel, limits)).toEqual({ type: "unchanged" })
    expect(workers).toHaveLength(2)
    yield* Effect.promise(() => workers[1].terminate())
  }),
)

it.live("missing worker artifacts fall back to in-process image normalization", () =>
  Effect.gen(function* () {
    const resize = makeWith(Effect.fail(new UnavailableError()))
    expect(yield* resize(pixel, limits)).toEqual({ type: "unchanged" })
    expect(yield* resize("invalid", limits)).toEqual({ type: "decode-error" })
  }),
)

it.live("a crashed image worker fails its request and is replaced", () =>
  Effect.gen(function* () {
    let attempts = 0
    const workers: Worker[] = []
    const spawn = Effect.suspend(() =>
      spawnWorker(attempts++ === 0 ? new URL("../fixture/photon-crash-worker.ts", import.meta.url) : undefined),
    ).pipe(Effect.tap((worker) => Effect.sync(() => workers.push(worker))))
    const resize = makeWith(spawn)
    expect(yield* resize(pixel, limits)).toEqual({ type: "decode-error" })
    expect(yield* resize(pixel, limits)).toEqual({ type: "unchanged" })
    expect(attempts).toBe(2)
    yield* Effect.promise(() => workers[1].terminate())
  }),
)

it.live("cancelling an image request discards its busy worker before the next request", () =>
  Effect.gen(function* () {
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    let attempts = 0
    const workers: Worker[] = []
    const exits: Promise<void>[] = []
    const spawn = Effect.suspend(() =>
      spawnWorker(attempts++ === 0 ? new URL("../fixture/photon-busy-worker.ts", import.meta.url) : undefined),
    ).pipe(
      Effect.tap((worker) =>
        Effect.sync(() => {
          workers.push(worker)
          exits.push(new Promise<void>((resolve) => worker.once("exit", () => resolve())))
          worker.on("message", (message) => {
            if (message.type === "started") started()
          })
        }),
      ),
    )
    const resize = makeWith(spawn)
    const fiber = yield* resize(pixel, limits).pipe(Effect.forkScoped)
    yield* Effect.promise(() => entered)
    yield* Fiber.interrupt(fiber)
    yield* Effect.promise(() => exits[0])
    expect(workers[0].threadId).toBe(-1)
    expect(yield* resize(pixel, limits)).toEqual({ type: "unchanged" })
    expect(attempts).toBe(2)
    yield* Effect.promise(() => workers[1].terminate())
  }),
)
