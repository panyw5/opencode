import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, type SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { TaskListTool } from "@/tool/task_list"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer, SessionStatus.defaultLayer, Truncate.defaultLayer),
)

const context = (sessionID: SessionID) => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const addAssistant = Effect.fn("TaskListTest.addAssistant")(function* (
  sessionID: SessionID,
  input: { completed?: number; error?: boolean },
) {
  const sessions = yield* Session.Service
  return yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: MessageID.ascending(),
    sessionID,
    mode: "general",
    agent: "general",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test",
    providerID: "test",
    time: { created: 1, completed: input.completed },
    error: input.error ? ({ name: "UnknownError", data: { message: "failed" } } as never) : undefined,
  })
})

describe("tool.task_list", () => {
  it.instance("lists descendants with hierarchy and excludes unrelated sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const statuses = yield* SessionStatus.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child", agent: "general" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "Grandchild", agent: "general" })
      const unrelated = yield* sessions.create({ title: "Unrelated" })
      yield* statuses.set(child.id, { type: "busy" })
      yield* addAssistant(grandchild.id, { completed: 2 })

      const tool = yield* TaskListTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, context(parent.id))
      const output = JSON.parse(result.output) as {
        tasks: Array<{ task_id: string; parent_task_id: string; depth: number; state: string }>
      }

      expect(output.tasks.map((task) => task.task_id)).toEqual([child.id, grandchild.id])
      expect(output.tasks.some((task) => task.task_id === unrelated.id)).toBe(false)
      expect(output.tasks[0]).toMatchObject({ parent_task_id: parent.id, depth: 1, state: "running" })
      expect(output.tasks[1]).toMatchObject({ parent_task_id: child.id, depth: 2, state: "completed" })

      const direct = yield* def.execute({ scope: "children" }, context(parent.id))
      expect((JSON.parse(direct.output) as { tasks: unknown[] }).tasks).toHaveLength(1)
    }),
  )

  it.instance("reports an unfinished child without a local live runner as unknown", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      yield* addAssistant(child.id, {})

      const tool = yield* TaskListTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, context(parent.id))
      expect(result.output).toContain('"state": "unknown"')
      expect(result.output).toContain(child.id)
    }),
  )

  it.instance("does not treat a completed intermediate tool-call step as a completed task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const message = yield* addAssistant(child.id, { completed: 2 })
      yield* sessions.updateMessage({ ...message, finish: "tool-calls" })

      const tool = yield* TaskListTool
      const def = yield* tool.init()
      const result = yield* def.execute({}, context(parent.id))
      expect(result.output).toContain('"state": "unknown"')
    }),
  )
})
