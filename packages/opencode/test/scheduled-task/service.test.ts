import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Database, eq } from "@/storage/db"
import { InstanceStore } from "@/project/instance-store"
import type { InstanceContext } from "@/project/instance-context"
import { LocationLifecycle } from "@/project/location-lifecycle"
import { Project } from "@/project/project"
import { ProjectTable } from "@/project/project.sql"
import { LocationID, ProjectID } from "@/project/schema"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import { ScheduledTask } from "@/scheduled-task/service"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "@/scheduled-task/scheduled-task.sql"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { InstanceRef } from "@/effect/instance-ref"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { pollWithTimeout, testEffect } from "../lib/effect"

// The real lifecycle gate guards execution; the instance store behind it hangs
// forever so a claimed run stays "running" without invoking session services.
const dependencies = Layer.mergeAll(
  LocationLifecycle.layer.pipe(
    Layer.provide([Layer.mock(InstanceStore.Service, { load: () => Effect.never }), AppFileSystem.defaultLayer]),
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

describe("ScheduledTask automatic sessions", () => {
  it.live("reuses a session until its token limit, then rotates and references the previous session", () =>
    Effect.gen(function* () {
      const now = Date.now()
      const directory = "/tmp"
      const projectID = ProjectID.make(`scheduled-task-automatic-${crypto.randomUUID()}`)
      const locationID = LocationID.ascending()
      const sourceSessionID = SessionID.make(`ses_source_${crypto.randomUUID()}`)
      Database.use((db) => {
        db.insert(ProjectTable)
          .values({ id: projectID, worktree: directory, sandboxes: [], time_created: now, time_updated: now })
          .run()
        db.insert(SessionTable)
          .values({
            id: sourceSessionID,
            project_id: projectID,
            slug: "scheduled-source",
            directory,
            title: "Scheduled source",
            version: "test",
            time_created: now,
            time_updated: now,
          })
          .run()
      })
      const task = yield* ScheduledTaskRepository.create(
        {
          projectID,
          directory,
          name: "Automatic review",
          prompt: "Review the workspace",
          schedule: { kind: "at", at: now + 3_600_000 },
          executionMode: "automatic_session",
          sessionID: sourceSessionID,
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          unattended: true,
        },
        now,
      )

      const created: SessionID[] = []
      const dispatched: Array<{ sessionID: SessionID; text: string; previousSessionID?: string }> = []
      const instance = {
        directory,
        directoryKey: directory,
        nativeDirectory: directory,
        worktree: directory,
        project: { id: projectID },
        location: { id: locationID },
      } as InstanceContext
      const executionDependencies = Layer.mergeAll(
        Layer.mock(LocationLifecycle.Service, {
          provide: (_input, effect) => effect.pipe(Effect.provideService(InstanceRef, instance)),
        }),
        Layer.mock(Project.Service, {
          claimLegacy: () => Effect.succeed({ sessions: 0, scheduledTasks: 0, workspaces: 0 }),
        }),
        Layer.mock(Session.Service, {
          create: (input) =>
            Effect.sync(() => {
              const id = SessionID.make(`ses_run_${crypto.randomUUID()}`)
              created.push(id)
              Database.use((db) =>
                db
                  .insert(SessionTable)
                  .values({
                    id,
                    project_id: projectID,
                    slug: `scheduled-run-${created.length}`,
                    directory,
                    title: input?.title ?? "Scheduled run",
                    version: "test",
                    time_created: Date.now(),
                    time_updated: Date.now(),
                  })
                  .run(),
              )
              return { id, title: input?.title ?? "Scheduled run" } as never
            }),
          get: (sessionID) =>
            Effect.sync(() => {
              const row = Database.use((db) =>
                db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
              )
              return row
                ? ({
                    id: row.id,
                    title: row.title,
                    tokens: {
                      input: row.tokens_input,
                      output: row.tokens_output,
                      reasoning: row.tokens_reasoning,
                      cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
                    },
                  } as never)
                : undefined
            }),
          setTitle: () => Effect.void,
        }),
        Layer.mock(SessionPrompt.Service, {
          prompt: (input) =>
            Effect.sync(() => {
              const part = input.parts.find((item) => item.type === "text")
              dispatched.push({
                sessionID: input.sessionID,
                text: part?.type === "text" ? part.text : "",
                previousSessionID:
                  part?.type === "text" && typeof part.metadata?.previousSessionID === "string"
                    ? part.metadata.previousSessionID
                    : undefined,
              })
              return {} as never
            }),
        }),
        Layer.mock(SessionStatus.Service, { get: () => Effect.succeed({ type: "idle" as const }) }),
        Layer.mock(Agent.Service, { get: () => Effect.succeed({} as never) }),
      )

      yield* Effect.gen(function* () {
        const scheduled = yield* ScheduledTask.Service
        for (let index = 0; index < 2; index++) {
          yield* scheduled.runNow(task.id)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              if (dispatched.length === index + 1) return true
              const latest = (yield* ScheduledTaskRepository.listRuns(task.id, 1))[0]
              if (latest?.status === "error" || latest?.status === "skipped") {
                return yield* Effect.fail(new Error(`automatic run stopped: ${JSON.stringify(latest)}`))
              }
              return undefined
            }),
            `automatic run ${index + 1} did not dispatch`,
          )
          yield* Effect.sleep("2 millis")
        }
        yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .update(SessionTable)
              .set({ tokens_input: 1_000_000 })
              .where(eq(SessionTable.id, sourceSessionID))
              .run(),
          ),
        )
        for (let index = 2; index < 4; index++) {
          yield* scheduled.runNow(task.id)
          yield* pollWithTimeout(
            Effect.gen(function* () {
              if (dispatched.length === index + 1) return true
              const latest = (yield* ScheduledTaskRepository.listRuns(task.id, 1))[0]
              if (latest?.status === "error" || latest?.status === "skipped") {
                return yield* Effect.fail(new Error(`automatic run stopped: ${JSON.stringify(latest)}`))
              }
              return undefined
            }),
            `automatic run ${index + 1} did not dispatch`,
          )
          yield* Effect.sleep("2 millis")
        }
      }).pipe(Effect.provide(ScheduledTask.layer.pipe(Layer.provide(executionDependencies))))

      expect(created).toHaveLength(1)
      expect(created[0]).not.toBe(sourceSessionID)
      expect(dispatched.map((item) => item.sessionID)).toEqual([
        sourceSessionID,
        sourceSessionID,
        created[0],
        created[0],
      ])
      expect(dispatched.map((item) => item.previousSessionID)).toEqual([
        undefined,
        undefined,
        sourceSessionID,
        undefined,
      ])
      expect(dispatched.map((item) => item.text)).toEqual([
        "Review the workspace",
        "Review the workspace",
        `<scheduled-task-context previous_session_id="${sourceSessionID}" />\n\nReview the workspace`,
        "Review the workspace",
      ])
      expect((yield* ScheduledTaskRepository.get(task.id))?.sessionID).toBe(created[0])
    }),
  )
})
