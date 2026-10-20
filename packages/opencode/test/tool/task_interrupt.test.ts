import { afterEach, describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionInput } from "@/session/input"
import { SessionRunState } from "@/session/run-state"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { TaskInterruptTool } from "@/tool/task_interrupt"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Config.defaultLayer,
    Session.defaultLayer,
    SessionInput.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
  ),
)

const context = (sessionID: SessionID, cancel: TaskPromptOps["cancel"] = () => Effect.void) => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  extra: { promptOps: { cancel } },
})

const addAssistant = Effect.fn("TaskInterruptTest.addAssistant")(function* (sessionID: SessionID, completed = false) {
  const sessions = yield* Session.Service
  const message: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID,
    mode: "general",
    agent: "general",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test",
    time: { created: Date.now(), ...(completed ? { completed: Date.now() } : {}) },
    ...(completed ? { finish: "stop" } : {}),
  }
  yield* sessions.updateMessage(message)
  return { info: message, parts: [] } satisfies MessageV2.WithParts
})

describe("tool.task_interrupt", () => {
  it.instance("stops a background child, awaits cleanup, preserves history and immediately resumes the same task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const runs = yield* SessionRunState.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const parentMessage = yield* addAssistant(parent.id)
      const ready = yield* Deferred.make<void>()
      let childMessage: MessageV2.WithParts | undefined
      let cleaned = false
      const ops: TaskPromptOps = {
        cancel: (id) => runs.cancel(id, sessions.finalizeOrphanedAssistant(id, { abortSource: "user-cancel" })),
        resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
        loop: () => Effect.die(new Error("unexpected parent notification after interruption")),
        prompt: (input) =>
          Effect.gen(function* () {
            childMessage = yield* addAssistant(input.sessionID)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              sessionID: input.sessionID,
              messageID: childMessage.info.id,
              type: "text",
              text: "Partial answer before correction",
            })
            yield* Deferred.succeed(ready, undefined)
            return yield* Effect.never.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  cleaned = true
                }),
              ),
            )
          }),
      }
      const ctx = { ...context(parent.id, ops.cancel), messageID: parentMessage.info.id, extra: { promptOps: ops } }
      const task = yield* (yield* TaskTool).init()
      const launched = yield* task.execute(
        {
          description: "Work needing correction",
          prompt: "Start the original approach",
          subagent_type: "general",
          background: true,
        },
        ctx,
      )
      yield* Deferred.await(ready)
      const childID = SessionID.make(launched.metadata.sessionId)
      const interrupt = yield* (yield* TaskInterruptTool).init()
      const stopped = yield* interrupt
        .execute({ task_id: childID, reason: "Use the corrected normalization" }, ctx)
        .pipe(Effect.timeout("3 seconds"))

      expect(stopped.metadata.interrupted).toBe(true)
      expect(stopped.output).toContain(`task_id: ${childID}`)
      expect(cleaned).toBe(true)
      expect((yield* jobs.get(childID))?.status).toBe("cancelled")
      const saved = yield* MessageV2.get({ sessionID: childID, messageID: childMessage!.info.id })
      expect(saved.parts.some((part) => part.type === "text" && part.text === "Partial answer before correction")).toBe(
        true,
      )

      let resumedID: SessionID | undefined
      const resumed = yield* task.execute(
        {
          task_id: childID,
          description: "Corrected work",
          prompt: "Correct the previous answer using normalization B, not A",
          subagent_type: "general",
        },
        {
          ...ctx,
          extra: {
            promptOps: {
              ...ops,
              prompt: (input) =>
                Effect.gen(function* () {
                  resumedID = input.sessionID
                  expect(input.parts).toEqual([
                    { type: "text", text: "Correct the previous answer using normalization B, not A" },
                  ])
                  return yield* addAssistant(input.sessionID, true)
                }),
            },
          },
        },
      )
      expect(resumedID).toBe(childID)
      expect(resumed.metadata.sessionId).toBe(childID)
      expect(yield* sessions.children(parent.id)).toHaveLength(1)
    }),
  )

  it.instance("stops a foreground runner without affecting its parent or sibling", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const runs = yield* SessionRunState.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const sibling = yield* sessions.create({ parentID: parent.id, title: "Sibling" })
      const reply = yield* addAssistant(child.id)
      const ready = yield* Deferred.make<void>()
      yield* statuses.set(parent.id, { type: "busy" })
      yield* statuses.set(sibling.id, { type: "busy" })
      const fiber = yield* runs
        .ensureRunning(
          child.id,
          Effect.succeed(reply),
          statuses
            .set(child.id, { type: "busy" })
            .pipe(Effect.andThen(Deferred.succeed(ready, undefined)), Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      const tool = yield* (yield* TaskInterruptTool).init()
      const result = yield* tool.execute(
        { task_id: child.id },
        context(parent.id, (id) => runs.cancel(id)),
      )
      expect(result.metadata.interrupted).toBe(true)
      yield* Fiber.await(fiber)
      expect((yield* statuses.get(child.id)).type).toBe("idle")
      expect((yield* statuses.get(parent.id)).type).toBe("busy")
      expect((yield* statuses.get(sibling.id)).type).toBe("busy")
    }),
  )

  it.instance("allows descendants and cancels their owned background jobs", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const runs = yield* SessionRunState.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "Grandchild" })
      const nested = yield* sessions.create({ parentID: grandchild.id, title: "Nested" })
      for (const task of [grandchild, nested]) {
        yield* jobs.start({
          id: task.id,
          type: "task",
          metadata: { parentSessionId: task.parentID },
          run: Effect.never,
        })
      }
      const tool = yield* (yield* TaskInterruptTool).init()
      const result = yield* tool.execute(
        { task_id: grandchild.id },
        context(parent.id, (id) => runs.cancel(id)),
      )
      expect(result.metadata.interrupted).toBe(true)
      expect((yield* jobs.get(grandchild.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(nested.id))?.status).toBe("cancelled")
    }),
  )

  it.instance("rejects self, ancestors, siblings, unrelated and missing sessions without cancelling anything", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const root = yield* sessions.create({ title: "Root" })
      const parent = yield* sessions.create({ parentID: root.id, title: "Parent" })
      const sibling = yield* sessions.create({ parentID: root.id, title: "Sibling" })
      const unrelated = yield* sessions.create({ title: "Unrelated" })
      let cancelled = false
      const ctx = context(parent.id, () =>
        Effect.sync(() => {
          cancelled = true
        }),
      )
      const tool = yield* (yield* TaskInterruptTool).init()
      for (const id of [root.id, parent.id, sibling.id, unrelated.id, SessionID.make("ses_missing")]) {
        expect(Exit.isFailure(yield* tool.execute({ task_id: id }, ctx).pipe(Effect.exit))).toBe(true)
      }
      expect(cancelled).toBe(false)
    }),
  )

  it.instance("does not finalize an unfinished session with no local runner, including repeated calls", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Possibly owned by another server" })
      const message = yield* addAssistant(child.id)
      let cancelled = false
      const ctx = context(parent.id, () =>
        Effect.sync(() => {
          cancelled = true
        }),
      )
      const tool = yield* (yield* TaskInterruptTool).init()
      for (let i = 0; i < 2; i++) {
        const result = yield* tool.execute({ task_id: child.id }, ctx)
        expect(result.metadata.interrupted).toBe(false)
        expect(result.output).toContain("another server")
      }
      expect(cancelled).toBe(false)
      const saved = yield* MessageV2.get({ sessionID: child.id, messageID: message.info.id })
      expect(saved.info.time.completed).toBeUndefined()
    }),
  )

  it.instance("honors the task_interrupt permission before stopping a child", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      yield* statuses.set(child.id, { type: "busy" })
      let cancelled = false
      const ctx = context(parent.id, () =>
        Effect.sync(() => {
          cancelled = true
        }),
      )
      const tool = yield* (yield* TaskInterruptTool).init()
      const result = yield* tool
        .execute(
          { task_id: child.id },
          {
            ...ctx,
            ask: (input) =>
              Effect.sync(() => {
                expect(input.permission).toBe("task_interrupt")
                expect(input.patterns).toEqual([child.id])
                throw new Error("permission denied")
              }),
          },
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(cancelled).toBe(false)
      expect((yield* statuses.get(child.id)).type).toBe("busy")
    }),
  )

  it.instance("rejects a descendant in another workspace before attempting cancellation", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Detached worker" })
      let cancelled = false
      const tool = yield* TaskInterruptTool.pipe(
        Effect.provideService(Session.Service, {
          ...sessions,
          get: (id) =>
            sessions
              .get(id)
              .pipe(
                Effect.map((session) => (id === child.id ? { ...session, directory: "/another-workspace" } : session)),
              ),
        }),
      )
      const def = yield* tool.init()
      const result = yield* def
        .execute(
          { task_id: child.id },
          context(parent.id, () =>
            Effect.sync(() => {
              cancelled = true
            }),
          ),
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(result)).toBe(true)
      expect(cancelled).toBe(false)
    }),
  )

  it.instance("does not claim successful interruption when cancellation fails or leaves the runner busy", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      yield* statuses.set(child.id, { type: "busy" })
      const tool = yield* (yield* TaskInterruptTool).init()
      for (const cancel of [() => Effect.die(new Error("cancel failed")), () => Effect.void]) {
        const result = yield* tool.execute({ task_id: child.id }, context(parent.id, cancel)).pipe(Effect.exit)
        expect(Exit.isFailure(result)).toBe(true)
      }
      expect((yield* statuses.get(child.id)).type).toBe("busy")
    }),
  )

  it.instance("rejects cyclic ancestry rather than looping or reaching unrelated tasks", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const a = yield* sessions.create({ title: "Cycle A" })
      const b = yield* sessions.create({ parentID: a.id, title: "Cycle B" })
      const tool = yield* TaskInterruptTool.pipe(
        Effect.provideService(Session.Service, {
          ...sessions,
          get: (id) =>
            sessions.get(id).pipe(Effect.map((session) => (id === a.id ? { ...session, parentID: b.id } : session))),
        }),
      )
      const def = yield* tool.init()
      expect(Exit.isFailure(yield* def.execute({ task_id: a.id }, context(parent.id)).pipe(Effect.exit))).toBe(true)
    }),
  )
})
