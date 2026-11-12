import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { FileChange } from "@/session/file-change"
import { MessageID, SessionID } from "@/session/schema"
import { ApplyPatchTool } from "@/tool/apply_patch"
import { EditTool } from "@/tool/edit"
import { WriteTool } from "@/tool/write"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "node:path"

let formatAction = (_file: string): Effect.Effect<boolean> => Effect.succeed(false)
let failDiagnostics = false
const it = testEffect(
  Layer.mergeAll(
    AppFileSystem.defaultLayer,
    Bus.layer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
    Layer.mock(Format.Service, { file: (file) => formatAction(file) }),
    Layer.mock(LSP.Service, {
      touchFile: () => Effect.void,
      diagnostics: () => (failDiagnostics ? Effect.die(new Error("diagnostics failed")) : Effect.succeed({})),
    }),
  ),
)

function context(changes: FileChange.Input[], ask = () => Effect.void): Tool.Context {
  return {
    sessionID: SessionID.make("ses_file_mutation"),
    messageID: MessageID.make("msg_file_mutation"),
    callID: "call_mutation",
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask,
    recordFileChange: (input) =>
      Effect.sync(() => {
        changes.push(input)
      }),
  }
}

it.instance("persists writes before diagnostics and records formatter output separately", () =>
  Effect.gen(function* () {
    failDiagnostics = true
    const fs = yield* AppFileSystem.Service
    const dir = yield* TestInstance
    const file = path.join(dir.directory, "owned.txt")
    formatAction = (file) => fs.writeWithDirs(file, "formatted\n").pipe(Effect.as(true), Effect.orDie)
    const changes: FileChange.Input[] = []
    const tool = yield* (yield* WriteTool).init()
    const exit = yield* tool.execute({ filePath: file, content: "unformatted\n" }, context(changes)).pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(changes).toEqual([
      { tool: "write", file, before: null, after: "unformatted\n" },
      { tool: "write", file, before: "unformatted\n", after: "formatted\n", source: "formatter" },
    ])
    failDiagnostics = false
    formatAction = () => Effect.succeed(false)
  }),
)

it.instance("rejects a stale baseline after permission without claiming the external edit", () =>
  Effect.gen(function* () {
    failDiagnostics = false
    formatAction = () => Effect.succeed(false)
    const fs = yield* AppFileSystem.Service
    const dir = yield* TestInstance
    const file = path.join(dir.directory, "owned.txt")
    yield* fs.writeWithDirs(file, "before")
    const changes: FileChange.Input[] = []
    const tool = yield* (yield* EditTool).init()
    const exit = yield* tool
      .execute(
        { filePath: file, oldString: "before", newString: "mine" },
        context(changes, () => fs.writeWithDirs(file, "external").pipe(Effect.orDie)),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(changes).toEqual([])
    expect(yield* fs.readFileString(file)).toBe("external")
  }),
)

it.instance("records only successfully applied files when a multi-file patch fails partway", () =>
  Effect.gen(function* () {
    formatAction = () => Effect.succeed(false)
    const fs = yield* AppFileSystem.Service
    const dir = yield* TestInstance
    const one = path.join(dir.directory, "one.txt")
    const two = path.join(dir.directory, "two.txt")
    yield* fs.writeWithDirs(one, "old\n")
    yield* fs.writeWithDirs(two, "old\n")
    const changes: FileChange.Input[] = []
    const tool = yield* (yield* ApplyPatchTool).init()
    const exit = yield* tool
      .execute(
        {
          patchText:
            "*** Begin Patch\n*** Update File: one.txt\n@@\n-old\n+mine\n*** Update File: two.txt\n@@\n-old\n+mine\n*** End Patch",
        },
        context(changes, () => fs.writeWithDirs(two, "external\n").pipe(Effect.orDie)),
      )
      .pipe(Effect.exit)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(changes).toEqual([{ tool: "apply_patch", file: one, before: "old\n", after: "mine\n" }])
    expect(yield* fs.readFileString(two)).toBe("external\n")
  }),
)

it.instance("serializes edit and write operations through the same per-file lock", () =>
  Effect.gen(function* () {
    formatAction = () => Effect.succeed(false)
    const fs = yield* AppFileSystem.Service
    const dir = yield* TestInstance
    const file = path.join(dir.directory, "owned.txt")
    yield* fs.writeWithDirs(file, "before")
    const ready = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const changes: FileChange.Input[] = []
    const edit = yield* (yield* EditTool).init()
    const write = yield* (yield* WriteTool).init()
    const first = yield* edit
      .execute(
        { filePath: file, oldString: "before", newString: "edited" },
        context(changes, () => Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release)))),
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(ready)
    const second = yield* write.execute({ filePath: file, content: "written" }, context(changes)).pipe(Effect.forkChild)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(first)
    yield* Fiber.join(second)
    expect(changes.map(({ before, after }) => ({ before, after }))).toEqual([
      { before: "before", after: "edited" },
      { before: "edited", after: "written" },
    ])
  }),
)
