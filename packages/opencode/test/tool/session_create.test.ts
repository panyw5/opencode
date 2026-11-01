import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { InstanceState } from "@/effect/instance-state"
import { WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceID } from "@/control-plane/schema"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { SessionCreateTool } from "@/tool/session_create"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, TestInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer, Truncate.defaultLayer, AppFileSystem.defaultLayer).pipe(
    Layer.provideMerge(testInstanceStoreLayer),
  ),
)

const context = (sessionID: SessionID, ask: Tool.Context["ask"] = () => Effect.void): Tool.Context => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask,
})

describe("tool.session_create", () => {
  it.instance("creates an empty independent root session, even when called by a child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create()
      const caller = yield* sessions.create({
        parentID: parent.id,
        permission: [{ permission: "edit", pattern: "*", action: "deny" }],
      })
      const tool = yield* SessionCreateTool
      const def = yield* tool.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const result = yield* def.execute(
        { title: "  Independent work  " },
        context(caller.id, (input) => Effect.sync(() => void requests.push(input))),
      )
      const created = yield* sessions.get(result.metadata.session_id)

      expect(created.id).not.toBe(caller.id)
      expect(created.title).toBe("Independent work")
      expect(created.parentID).toBeUndefined()
      expect(created.permission).toBeUndefined()
      expect(created.mountedTaskID).toBeUndefined()
      expect(created.directory).toBe(caller.directory)
      expect(created.projectID).toBe(caller.projectID)
      expect((yield* MessageV2.page({ sessionID: created.id, limit: 20 })).items).toEqual([])
      expect(JSON.parse(result.output)).toEqual(result.data)
      expect(requests).toEqual([
        {
          permission: "session_create",
          patterns: [caller.directory],
          always: ["*"],
          metadata: { directory: caller.directory, title: "Independent work" },
        },
      ])
    }),
  )

  it.instance("uses the default title when no arguments are provided", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const caller = yield* sessions.create()
      const def = yield* (yield* SessionCreateTool).init()
      const result = yield* def.execute({}, context(caller.id))
      const created = yield* sessions.get(result.metadata.session_id)
      expect(created.title).toStartWith("New session - ")
      expect(created.parentID).toBeUndefined()
    }),
  )

  it.instance(
    "creates in another project without leaking caller workspace or changing caller context",
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const caller = yield* sessions.create()
        const target = yield* tmpdirScoped({ git: true })
        const def = yield* (yield* SessionCreateTool).init()
        const permissions: string[] = []
        const result = yield* def
          .execute(
            { directory: target, title: "Other project" },
            context(caller.id, (input) => Effect.sync(() => void permissions.push(input.permission))),
          )
          .pipe(Effect.provideService(WorkspaceRef, WorkspaceID.make("wrk_caller")))
        const created = yield* sessions.get(result.metadata.session_id)
        expect(created.directory).toBe(target)
        expect(created.projectID).not.toBe(caller.projectID)
        expect(created.parentID).toBeUndefined()
        expect(created.workspaceID).toBeUndefined()
        expect(permissions).toEqual(["external_directory", "session_create"])
        expect(yield* InstanceState.directory).toBe(caller.directory)
        expect((yield* sessions.get(caller.id)).directory).toBe(caller.directory)
      }),
    { git: true },
  )

  it.instance("resolves relative paths against the current instance directory", () =>
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const test = yield* TestInstance
      const target = path.join(test.directory, "nested")
      yield* fs.makeDirectory(target)
      const sessions = yield* Session.Service
      const caller = yield* sessions.create()
      const def = yield* (yield* SessionCreateTool).init()
      const result = yield* def.execute({ directory: "nested" }, context(caller.id))
      expect((yield* sessions.get(result.metadata.session_id)).directory).toBe(target)
    }),
  )

  it.instance("retains the current workspace for a session in the same directory", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const caller = yield* sessions.create()
      const def = yield* (yield* SessionCreateTool).init()
      const workspaceID = WorkspaceID.make("wrk_current")
      const result = yield* def.execute({}, context(caller.id)).pipe(Effect.provideService(WorkspaceRef, workspaceID))
      expect((yield* sessions.get(result.metadata.session_id)).workspaceID).toBe(workspaceID)
    }),
  )

  it.instance("does not create a session when authorization is rejected", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const caller = yield* sessions.create()
      const before = yield* sessions.list()
      const def = yield* (yield* SessionCreateTool).init()
      const exit = yield* def
        .execute(
          {},
          context(caller.id, () => Effect.die(new Error("denied"))),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.list()).toEqual(before)
    }),
  )

  it.instance("rejects blank inputs, missing paths, and files without creating sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const caller = yield* sessions.create()
      const fs = yield* AppFileSystem.Service
      const test = yield* TestInstance
      yield* fs.writeFileString(path.join(test.directory, "file.txt"), "not a directory")
      const before = yield* sessions.list()
      const def = yield* (yield* SessionCreateTool).init()
      for (const params of [
        { title: "" },
        { title: "   " },
        { directory: "" },
        { directory: "   " },
        { directory: "missing" },
        { directory: "file.txt" },
      ]) {
        const exit = yield* def.execute(params, context(caller.id)).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
      expect(yield* sessions.list()).toEqual(before)
    }),
  )

  it.instance("honors the lifecycle admission gate for other directories", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const caller = yield* sessions.create()
      const target = yield* tmpdirScoped()
      const before = yield* sessions.list()
      const def = yield* (yield* SessionCreateTool).init()
      const exit = yield* def.execute({ directory: target }, context(caller.id)).pipe(
        Effect.provide(
          Layer.mock(LocationLifecycle.Service, {
            provide: () => Effect.fail(new LocationLifecycle.LocationDeleted({ directory: target })),
          }),
        ),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sessions.list()).toEqual(before)
    }),
  )
})
