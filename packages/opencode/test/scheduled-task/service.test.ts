import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Database, eq } from "@/storage/db"
import { InstanceStore } from "@/project/instance-store"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Project } from "@/project/project"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import { ScheduledTask } from "@/scheduled-task/service"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@/scheduled-task/scheduled-task.sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { pollWithTimeout, testEffect } from "../lib/effect"

// The real lifecycle gate guards execution; the instance store behind it hangs
// forever so a claimed run stays "running" without invoking session services.
const dependencies = Layer.mergeAll(
  LocationLifecycle.layer.pipe(
    Layer.provide([
      Layer.mock(InstanceStore.Service, { load: () => Effect.never }),
      AppFileSystem.defaultLayer,
    ]),
  ),
  Layer.mock(Project.Service, {
    claimLegacy: () => Effect.succeed({ sessions: 0, scheduledTasks: 0, workspaces: 0 }),
  }),
  Layer.mock(Session.Service, {}),
  Layer.mock(SessionPrompt.Service, {}),
  Layer.mock(SessionStatus.Service, {}),
  Layer.mock(Agent.Service, {}),
)
const it = testEffect(Layer.empty)

beforeEach(() =>
  Database.use((db) => {
    db.delete(ScheduledTaskRunTable).run()
    db.delete(ScheduledTaskTable).run()
  }),
)

describe("ScheduledTask service startup", () => {
  it.live("runs an occurrence that becomes due at startup exactly once", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const projectID = ProjectID.make(`scheduled-task-startup-${crypto.randomUUID()}`)
      Database.use((db) =>
        db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: "/tmp", sandboxes: [], time_created: now, time_updated: now })
          .run(),
      )
      const task = yield* ScheduledTaskRepository.create(
        {
          projectID,
          directory: "/tmp",
          name: "Startup due",
          prompt: "Run once",
          schedule: { kind: "at", at: now },
          executionMode: "new_session",
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          unattended: true,
        },
        now,
      )

      yield* Layer.build(ScheduledTask.layer.pipe(Layer.provide(dependencies)))
      const runs = yield* pollWithTimeout(
        Effect.sync(() => {
          const rows = Database.use((db) =>
            db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.task_id, task.id)).all(),
          )
          return rows.length ? rows : undefined
        }),
        "startup occurrence was not recorded",
      )

      expect(runs).toHaveLength(1)
      expect(runs[0]?.scheduled_at).toBe(now)
      expect(runs[0]?.status).toBe("running")
    }),
  )

  it.live("skips the run without session services when the location directory is missing", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const projectID = ProjectID.make(`scheduled-task-missing-${crypto.randomUUID()}`)
      const missing = `/tmp/opencode-scheduled-missing-${crypto.randomUUID()}`
      Database.use((db) =>
        db
          .insert(ProjectTable)
          .values({ id: projectID, worktree: "/tmp", sandboxes: [], time_created: now, time_updated: now })
          .run(),
      )
      const task = yield* ScheduledTaskRepository.create(
        {
          projectID,
          directory: missing,
          name: "Missing directory",
          prompt: "Run once",
          schedule: { kind: "at", at: now },
          executionMode: "new_session",
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          unattended: true,
        },
        now,
      )

      yield* Layer.build(ScheduledTask.layer.pipe(Layer.provide(dependencies)))
      const runs = yield* pollWithTimeout(
        Effect.sync(() => {
          const rows = Database.use((db) =>
            db.select().from(ScheduledTaskRunTable).where(eq(ScheduledTaskRunTable.task_id, task.id)).all(),
          )
          return rows.some((row) => row.status === "skipped") ? rows : undefined
        }),
        "missing-directory run was not skipped",
      )

      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe("skipped")
      expect(runs[0]?.error).toContain("unavailable")
    }),
  )
})
