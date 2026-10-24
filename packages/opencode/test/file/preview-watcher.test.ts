import { describe, expect } from "bun:test"
import { rename } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { subscribe } from "../../src/file/preview-watcher"
import { disposeInstance } from "../../src/effect/instance-registry"
import { InstanceState } from "../../src/effect/instance-state"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

describe("visible file watcher", () => {
  it.instance("survives instance disposal, atomic replacement, deletion, and recreation without polling", () =>
    Effect.gen(function* () {
      const fixture = yield* TestInstance
      const file = path.join(fixture.directory, "build", "image.svg")
      yield* Effect.promise(() => Bun.write(file, "initial"))
      const ready = yield* Deferred.make<void>()
      let events = 0
      const stream = yield* subscribe("build/image.svg")
      const fiber = yield* stream.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            expect(event.properties.file).toBe(file)
            events++
            yield* Deferred.succeed(ready, undefined)
          }),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(ready)
      yield* Effect.promise(() => disposeInstance(fixture.directory))
      const mutate = (label: string, write: () => Promise<unknown>) =>
        Effect.gen(function* () {
          const previous = events
          console.debug(`[preview-watcher-test] step=${label} before=${previous}`)
          yield* Effect.promise(write)
          yield* pollWithTimeout(
            Effect.sync(() => (events > previous ? true : undefined)),
            `no visible-file invalidation: ${label}`,
            "3 seconds",
          )
        })
      yield* mutate("update", () => Bun.write(file, "updated"))
      yield* mutate("atomic", async () => {
        await Bun.write(`${file}.tmp`, "atomic")
        await rename(`${file}.tmp`, file)
      })
      yield* mutate("delete", () => import("node:fs/promises").then((fs) => fs.rm(file)))
      yield* mutate("recreate", () => Bun.write(file, "recreated"))
      yield* mutate("parent removed", () =>
        import("node:fs/promises").then((fs) => fs.rm(path.dirname(file), { recursive: true })),
      )
      yield* mutate("parent recreated", () => Bun.write(file, "new parent"))
      yield* mutate("update new parent", () => Bun.write(file, "new parent updated"))
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.instance("rejects escaped paths", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      expect(ctx.directory).toBeTruthy()
      const result = yield* Effect.exit(subscribe("../outside.svg"))
      expect(result._tag).toBe("Failure")
    }),
  )
})
