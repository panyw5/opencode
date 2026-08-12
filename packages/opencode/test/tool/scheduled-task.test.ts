import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Agent } from "@/agent/agent"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@/scheduled-task/scheduled-task.sql"
import { Database } from "@/storage/db"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import { ScheduledTaskCreateTool } from "@/tool/scheduled-task"
import type { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Exit, Layer } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer, Session.defaultLayer))

afterEach(async () => {
  await disposeAllInstances()
})

beforeEach(() => {
  Database.use((db) => {
    db.delete(ScheduledTaskRunTable).run()
    db.delete(ScheduledTaskTable).run()
  })
})

const context = Effect.fn("ScheduledTaskToolTest.context")(function* (ask: Tool.Context["ask"]) {
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ title: "Scheduled task tool test" })
  const message = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "test", modelID: "test-model", variant: "fast" },
  })
  return {
    session,
    ctx: {
      sessionID: session.id,
      messageID: message.id,
      agent: "build",
      abort: new AbortController().signal,
      messages: [{ info: message, parts: [] }],
      metadata: () => Effect.void,
      ask,
    } satisfies Tool.Context,
  }
})

describe("tool.scheduled_task_create", () => {
  it.instance("creates a task from the active project, session, agent, and model", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskCreateTool
      const tool = yield* info.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const { session, ctx } = yield* context((request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
      )

      const result = yield* tool.execute(
        {
          name: "Hourly review",
          prompt: "Review the current project",
          schedule: { kind: "every", interval: 3_600_000 },
          executionMode: "existing_session",
        },
        ctx,
      )
      const task = result.metadata.task

      expect(requests).toHaveLength(1)
      expect(requests[0]?.permission).toBe("scheduled_task_create")
      expect(task.directory).toBe(session.directory)
      expect(task.projectID).toBe(session.projectID)
      expect(task.sessionID).toBe(session.id)
      expect(task.agent).toBe("build")
      expect(task.model).toEqual({ providerID: "test", modelID: "test-model", variant: "fast" })
      expect(task.schedule).toEqual({ kind: "every", interval: 3_600_000 })
      expect(task.nextRunAt).toBeGreaterThan(task.time.created)
      expect(yield* ScheduledTaskRepository.get(task.id)).toEqual(task)
    }),
  )

  it.instance("does not persist when permission is rejected", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskCreateTool
      const tool = yield* info.init()
      const { ctx } = yield* context(() => Effect.fail(new Error("rejected")))

      const exit = yield* tool
        .execute(
          {
            name: "Rejected task",
            prompt: "This must not be stored",
            schedule: { kind: "every", interval: 60_000 },
          },
          ctx,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* ScheduledTaskRepository.list()).toEqual([])
    }),
  )

  it.instance("rejects an invalid cron expression without persisting", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskCreateTool
      const tool = yield* info.init()
      const { ctx } = yield* context(() => Effect.void)

      const exit = yield* tool
        .execute(
          {
            name: "Invalid cron",
            prompt: "This must not be stored",
            schedule: { kind: "cron", expression: "not cron", timezone: "Asia/Shanghai" },
          },
          ctx,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* ScheduledTaskRepository.list()).toEqual([])
    }),
  )
})
