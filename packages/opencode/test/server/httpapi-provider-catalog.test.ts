import { afterEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Server } from "../../src/server/server"
import { ModelPresetCatalog } from "../../src/server/routes/instance/httpapi/groups/provider"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test("preset response preserves sparse model metadata without inventing defaults", () => {
  const catalog = { sparse: { models: { speech: { id: "speech", cost: { input: 0 }, reasoning: false } } } }
  expect(Schema.encodeSync(ModelPresetCatalog)(catalog)).toEqual(catalog)
})

it.live(
  "provider catalog excludes user model overrides and runtime defaults",
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() =>
        tmpdir({
          config: {
            formatter: false,
            lsp: false,
            provider: {
              openai: {
                models: { "gpt-4o": { family: "user-override", reasoning: true, cost: { input: 999, output: 999 } } },
              },
            },
          },
        }),
      ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    )
    const response = yield* Effect.promise(() =>
      Promise.resolve(
        Server.Default().app.request("/provider/catalog", {
          headers: { "x-opencode-directory": tmp.path },
        }),
      ),
    )
    expect(response.status).toBe(200)
    const data = yield* Effect.promise(() => response.json())
    const fixture = yield* Effect.promise(() => Bun.file(process.env.OPENCODE_MODELS_PATH!).json())
    expect(data.openai.models["gpt-4o"]).toEqual(fixture.openai.models["gpt-4o"])
    expect(data.openai.models["gpt-4o"].family).not.toBe("user-override")
    expect(data.openai.models["gpt-4o"].cost.cache_write).toBeUndefined()
  }),
)
