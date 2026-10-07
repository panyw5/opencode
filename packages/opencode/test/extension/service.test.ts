import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { Extension } from "../../src/extension"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ExtensionRuntime } from "../../src/extension/runtime"

// Minimal server-extension fixture: activate() produces a disposable service
// so the lease tests can observe whether the shared runtime was torn down.
const SERVER_SOURCE = `
export default {
  id: "test.svc",
  async activate() {
    return { dispose: () => {} }
  },
  async server() {
    return {}
  },
}
`

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-service-"))
const registry = path.join(root, "registry.json")
const fixtureDir = path.join(root, "test-svc")

async function link() {
  await Bun.write(
    registry,
    JSON.stringify({
      version: 1,
      extensions: {
        "test.svc": {
          name: "test.svc",
          version: "1.0.0",
          source: { type: "path", path: fixtureDir },
          dir: fixtureDir,
          enabled: true,
          installedAt: Date.now(),
        },
      },
    }),
  )
}

/**
 * Imports and activates the fixture extension through the process runtime so
 * `describe` reports live state that teardown would clear.
 */
async function activateFixture() {
  await ExtensionRuntime.rpc({ id: "test.svc", method: "warmup" }).catch(() => undefined)
  expect(ExtensionRuntime.describe("test.svc")).toBeDefined()
}

function token(layer: Layer.Layer<Extension.Service>) {
  return Effect.runPromise(
    Extension.Service.pipe(
      Effect.map((service) => service.token),
      Effect.provide(layer),
    ),
  )
}

/**
 * Wraps a layer so it builds independently of the module-level `Extension.layer`
 * value: Effect memoizes shared layer nodes across provides, which would
 * collapse the two scopes under test into a single build with a single
 * finalizer set.
 */
function fresh(layer: Layer.Layer<Extension.Service>) {
  return Layer.fresh(layer)
}

beforeAll(async () => {
  await mkdir(path.join(fixtureDir, "dist"), { recursive: true })
  await Bun.write(path.join(fixtureDir, "dist/server.js"), SERVER_SOURCE)
  await Bun.write(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "test-svc",
      version: "1.0.0",
      type: "module",
      exports: { "./server": "./dist/server.js" },
      opencode: {
        manifestVersion: 1,
        id: "test.svc",
        displayName: "Test Service",
        activation: ["onStartup"],
      },
    }),
  )
})

beforeEach(() => {
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
})

afterEach(async () => {
  await ExtensionRuntime.testing.reset()
  await rm(registry, { force: true })
})

afterAll(async () => {
  delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  await rm(root, { recursive: true, force: true })
})

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

  test("an inner scope exiting keeps the shared runtime for the remaining scope", async () => {
    await link()
    await activateFixture()

    const inner = fresh(Extension.layer.pipe(Layer.provide(RuntimeFlags.layer())))
    const outer = fresh(Extension.layer.pipe(Layer.provide(RuntimeFlags.layer())))
    await Effect.runPromise(
      Effect.gen(function* () {
        // Leaving one of two concurrently live scopes must not tear down the
        // process-wide runtime the other scope still owns.
        yield* Extension.Service.pipe(
          Effect.map(() => undefined),
          Effect.provide(inner),
          Effect.scoped,
        )
        expect(ExtensionRuntime.describe("test.svc")).toBeDefined()
      }).pipe(Effect.provide(outer)),
    )

    // The last scope out performs the shutdown cleanup.
    expect(ExtensionRuntime.describe("test.svc")).toBeUndefined()
  })

  test("a pure-mode layer does not dispose runtime state owned by another scope", async () => {
    await link()
    await activateFixture()

    const pure = fresh(Extension.layer.pipe(Layer.provide(RuntimeFlags.layer({ pure: true }))))
    const owner = fresh(Extension.layer.pipe(Layer.provide(RuntimeFlags.layer())))
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Extension.Service.pipe(
          Effect.map(() => undefined),
          Effect.provide(pure),
          Effect.scoped,
        )
        // The pure layer never owned the runtime, so leaving it must not
        // dispose the enabled scope's state.
        expect(ExtensionRuntime.describe("test.svc")).toBeDefined()
      }).pipe(Effect.provide(owner)),
    )
    expect(ExtensionRuntime.describe("test.svc")).toBeUndefined()
  })
})
