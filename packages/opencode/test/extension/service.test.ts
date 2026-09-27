import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Extension } from "../../src/extension"
import { RuntimeFlags } from "../../src/effect/runtime-flags"

function token(layer: Layer.Layer<Extension.Service>) {
  return Effect.runPromise(
    Extension.Service.pipe(
      Effect.map((service) => service.token),
      Effect.provide(layer),
    ),
  )
}

describe("extension service", () => {
  test("shares one process token across independent layer builds", async () => {
    const a = Extension.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    const b = Extension.layer.pipe(Layer.provide(RuntimeFlags.layer()))
    expect(await token(a)).toBe(await token(b))
    expect(await token(a)).toMatch(/^[A-Za-z0-9_-]{24}$/)
  })

  test("returns an empty manifest in pure mode", async () => {
    const layer = Extension.layer.pipe(Layer.provide(RuntimeFlags.layer({ pure: true })))
    const list = await Effect.runPromise(
      Extension.Service.pipe(
        Effect.flatMap((service) => service.list()),
        Effect.provide(layer),
      ),
    )
    expect(list).toEqual([])
  })
})
