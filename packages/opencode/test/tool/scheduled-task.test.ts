import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Agent } from "@/agent/agent"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@/scheduled-task/scheduled-task.sql"
import { Database, eq } from "@/storage/db"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
import {
  ScheduledTaskCreateTool,
  ScheduledTaskDeleteTool,
  ScheduledTaskGetTool,
  ScheduledTaskListTool,
  ScheduledTaskRunsTool,
  ScheduledTaskRunNowTool,
  ScheduledTaskUpdateTool,
} from "@/tool/scheduled-task"
import type { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Truncate } from "@/tool/truncate"
import { ScheduledTask } from "@/scheduled-task/service"
import type { Run } from "@/scheduled-task/schema"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Exit, Layer } from "effect"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { InstanceState } from "@/effect/instance-state"

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
      const instance = yield* InstanceState.context
      const row = Database.use((db) =>
        db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, task.id)).get(),
      )

      expect(requests).toHaveLength(1)
      expect(requests[0]?.permission).toBe("scheduled_task_create")
      expect(task.directory).toBe(session.directory)
      expect(task.projectID).toBe(session.projectID)
      expect(task.sessionID).toBe(session.id)
      expect(task.agent).toBe("build")
      expect(task.model).toEqual({ providerID: "test", modelID: "test-model", variant: "fast" })
      expect(task.schedule).toEqual({ kind: "every", interval: 3_600_000 })
      expect(task.nextRunAt).toBeGreaterThan(task.time.created)
      expect(row?.location_id).toBe(instance.location.id)
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

describe("tool.scheduled_task_list", () => {
  it.instance("lists tasks scoped to the active location", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskListTool
      const tool = yield* info.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const { session, ctx } = yield* context((request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
      )
      const instance = yield* InstanceState.context
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        locationID: instance.location.id,
        directory: session.directory,
        name: "Listed task",
        prompt: "Do the thing",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })
      yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Legacy task without location",
        prompt: "Do not leak into the location list",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const result = yield* tool.execute({}, ctx)
      const list = JSON.parse(result.output) as Array<{ id: string }>

      expect(requests).toHaveLength(1)
      expect(requests[0]?.permission).toBe("scheduled_task_list")
      expect(result.metadata.count).toBe(1)
      expect(list[0]?.id).toBe(existing.id)
    }),
  )
})

describe("tool.scheduled_task_get", () => {
  it.instance("gets a task by id", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskGetTool
      const tool = yield* info.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const { session, ctx } = yield* context((request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
      )
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Gettable task",
        prompt: "Do the thing",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const result = yield* tool.execute({ taskID: existing.id }, ctx)
      const task = JSON.parse(result.output) as { id: string; name: string }

      expect(requests[0]?.permission).toBe("scheduled_task_get")
      expect(task.id).toBe(existing.id)
      expect(task.name).toBe("Gettable task")
    }),
  )
})

describe("tool.scheduled_task_update", () => {
  it.instance("exposes model and reasoning intensity to the LLM", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskUpdateTool
      const tool = yield* info.init()
      const schema = ToolJsonSchema.fromTool(tool)
      const properties = schema.properties as Record<string, { properties?: Record<string, unknown> }>

      expect(properties.model).toBeDefined()
      expect(properties.model?.properties?.providerID).toBeDefined()
      expect(properties.model?.properties?.modelID).toBeDefined()
      expect(properties.model?.properties?.variant).toBeDefined()
      expect(tool.description).toContain("reasoning/thinking intensity")
    }),
  )

  it.instance("updates all user-facing fields and binds the current session", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskUpdateTool
      const tool = yield* info.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const { session, ctx } = yield* context((request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
      )
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Old name",
        prompt: "Old prompt",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const result = yield* tool.execute(
        {
          taskID: existing.id,
          name: "New name",
          prompt: "New prompt",
          schedule: { kind: "every", interval: 86_400_000 },
          executionMode: "existing_session",
          model: { providerID: "new-provider", modelID: "new-model", variant: "high" },
          enabled: false,
        },
        ctx,
      )
      const task = JSON.parse(result.output) as {
        name: string
        prompt: string
        enabled: boolean
        schedule: { kind: string; interval: number }
        executionMode: string
        sessionID?: string
        model: { providerID: string; modelID: string; variant?: string }
      }

      expect(requests[0]?.permission).toBe("scheduled_task_update")
      expect(requests[0]?.metadata).toMatchObject({
        executionMode: "existing_session",
        model: { providerID: "new-provider", modelID: "new-model", variant: "high" },
      })
      expect(task.name).toBe("New name")
      expect(task.prompt).toBe("New prompt")
      expect(task.schedule).toEqual({ kind: "every", interval: 86_400_000 })
      expect(task.executionMode).toBe("existing_session")
      expect(task.sessionID).toBe(session.id)
      expect(task.model).toEqual({ providerID: "new-provider", modelID: "new-model", variant: "high" })
      expect(task.enabled).toBe(false)
      expect(yield* ScheduledTaskRepository.get(existing.id)).toEqual(result.metadata.task)
    }),
  )

  it.instance("clears the session binding when switching to new sessions", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskUpdateTool
      const tool = yield* info.init()
      const { session, ctx } = yield* context(() => Effect.void)
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Bound task",
        prompt: "Old prompt",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        sessionID: session.id,
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const result = yield* tool.execute({ taskID: existing.id, executionMode: "new_session" }, ctx)

      expect(result.metadata.task?.executionMode).toBe("new_session")
      expect(result.metadata.task?.sessionID).toBeUndefined()
      expect((yield* ScheduledTaskRepository.get(existing.id))?.sessionID).toBeUndefined()
    }),
  )

  it.instance("does not update when permission is rejected", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskUpdateTool
      const tool = yield* info.init()
      const { session, ctx } = yield* context(() => Effect.fail(new Error("rejected")))
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Untouched",
        prompt: "Old prompt",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const exit = yield* tool.execute({ taskID: existing.id, name: "Changed" }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* ScheduledTaskRepository.get(existing.id))?.name).toBe("Untouched")
    }),
  )
})

describe("tool.scheduled_task_delete", () => {
  it.instance("deletes a task by id", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskDeleteTool
      const tool = yield* info.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const { session, ctx } = yield* context((request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
      )
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Doomed task",
        prompt: "Do the thing",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const result = yield* tool.execute({ taskID: existing.id }, ctx)

      expect(requests[0]?.permission).toBe("scheduled_task_delete")
      expect(yield* ScheduledTaskRepository.get(existing.id)).toBeUndefined()
      expect(result.metadata.taskID).toBe(existing.id)
    }),
  )

  it.instance("does not delete when permission is rejected", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskDeleteTool
      const tool = yield* info.init()
      const { session, ctx } = yield* context(() => Effect.fail(new Error("rejected")))
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Keep me",
        prompt: "Do the thing",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const exit = yield* tool.execute({ taskID: existing.id }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* ScheduledTaskRepository.get(existing.id)).toBeDefined()
    }),
  )
})

describe("tool.scheduled_task_run_now", () => {
  it.instance("returns a graceful message when the runner is unavailable", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskRunNowTool
      const tool = yield* info.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const { session, ctx } = yield* context((request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
      )
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Run me now",
        prompt: "Do the thing",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })

      const result = yield* tool.execute({ taskID: existing.id }, ctx)
      const output = JSON.parse(result.output) as { error?: string }

      expect(requests[0]?.permission).toBe("scheduled_task_run_now")
      expect(output.error).toContain("not available")
      expect(result.metadata.run).toBeNull()
    }),
  )

  it.instance("starts a run through the scheduled task service", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskRunNowTool
      const tool = yield* info.init()
      const { session, ctx } = yield* context(() => Effect.void)
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "Run me now",
        prompt: "Do the thing",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })
      const run = {
        id: existing.id,
        taskID: existing.id,
        scheduledAt: Date.now(),
        status: "running",
        attempt: 0,
      } as unknown as Run

      const result = yield* tool.execute({ taskID: existing.id }, ctx).pipe(
        Effect.provide(
          Layer.mock(ScheduledTask.Service, {
            runNow: (id) => Effect.succeed({ ...run, taskID: id }),
            runs: () => Effect.succeed([]),
          }),
        ),
      )

      expect(JSON.parse(result.output)).toEqual(run)
      expect(result.metadata.run).toEqual(run)
    }),
  )
})

describe("tool.scheduled_task_runs", () => {
  it.instance("returns run history through the scheduled task service", () =>
    Effect.gen(function* () {
      const info = yield* ScheduledTaskRunsTool
      const tool = yield* info.init()
      const requests: Parameters<Tool.Context["ask"]>[0][] = []
      const { session, ctx } = yield* context((request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
      )
      const existing = yield* ScheduledTaskRepository.create({
        projectID: session.projectID,
        directory: session.directory,
        name: "History task",
        prompt: "Do the thing",
        schedule: { kind: "every", interval: 3_600_000 },
        executionMode: "existing_session",
        agent: "build",
        model: { providerID: "test", modelID: "test-model" },
        enabled: true,
        unattended: true,
      })
      const run = {
        id: existing.id,
        taskID: existing.id,
        scheduledAt: Date.now(),
        status: "ok",
        attempt: 0,
        time: { created: Date.now(), finished: Date.now() },
      } as unknown as Run

      const result = yield* tool.execute({ taskID: existing.id }, ctx).pipe(
        Effect.provide(
          Layer.mock(ScheduledTask.Service, {
            runs: () => Effect.succeed([run]),
          }),
        ),
      )

      expect(requests[0]?.permission).toBe("scheduled_task_runs")
      expect(result.metadata.count).toBe(1)
      expect(JSON.parse(result.output)).toEqual([run])
    }),
  )
})
