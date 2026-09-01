import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.live("no-ops for paths inside the instance directory", () =>
    provideInstance("/tmp/project")(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, path.join("/tmp/project", "file.txt"))

        expect(requests.length).toBe(0)
      }),
    ),
  )

  it.live("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      const directory = "/tmp/project"
      const target = "/tmp/outside/file.txt"
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* provideInstance(directory)(assertExternalDirectoryEffect(ctx, target))

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      const directory = "/tmp/project"
      const target = "/tmp/outside"
      const expected = glob(path.join(target, "*"))

      yield* provideInstance(directory)(assertExternalDirectoryEffect(ctx, target, { kind: "directory" }))

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    provideInstance("/tmp/project")(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

        expect(requests.length).toBe(0)
      }),
    ),
  )

  it.live("hard-blocks math workers from reading another problem workspace", () =>
    Effect.gen(function* () {
      const root = yield* tmpdirScoped()
      const own = path.join(root, "problem-a")
      const other = path.join(root, "problem-b")
      yield* Effect.promise(() => Promise.all([Bun.write(path.join(own, "fact.md"), "a"), Bun.write(path.join(other, "fact.md"), "b")]))
      const previous = process.env.OPENCODE_MATH_PROJECT_DIR
      process.env.OPENCODE_MATH_PROJECT_DIR = own
      try {
        const { requests, ctx } = makeCtx()
        ctx.agent = "math-worker"
        yield* assertExternalDirectoryEffect(ctx, path.join(own, "fact.md"))
        const exit = yield* Effect.exit(assertExternalDirectoryEffect(ctx, path.join(other, "fact.md")))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(requests).toHaveLength(0)
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_MATH_PROJECT_DIR
        else process.env.OPENCODE_MATH_PROJECT_DIR = previous
      }
    }),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )
  }
})
