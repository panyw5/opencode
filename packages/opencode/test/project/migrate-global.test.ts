import { describe, expect } from "bun:test"
import { Project } from "@/project/project"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { ScheduledTaskRepository } from "@/scheduled-task/repository"
import * as Log from "@opencode-ai/core/util/log"
import { $ } from "bun"
import { tmpdirScoped } from "../fixture/fixture"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Layer.mergeAll(Project.defaultLayer, CrossSpawnSpawner.defaultLayer))

function legacySessionID() {
  // Global-session migration covers persisted IDs from before prefixed session IDs.
  return crypto.randomUUID() as SessionID
}

function seed(opts: { id: SessionID; dir: string; project: ProjectID }) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id: opts.id,
        project_id: opts.project,
        slug: opts.id,
        directory: opts.dir,
        title: "test",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run(),
  )
}

function ensureGlobal() {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: "/",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
}

describe("migrateFromGlobal", () => {
  it.live("claims a legacy global session without changing directory identity", () =>
    Effect.gen(function* () {
      // 1. Start with git init but no commits — creates a stable directory project.
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.name "Test"`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.email "test@opencode.test"`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(tmp).quiet())
      const projects = yield* Project.Service
      const { project: pre, location: preLocation } = yield* projects.fromDirectory(tmp)
      expect(pre.id).toStartWith("dir:")
      expect(pre.id).not.toBe(ProjectID.global)

      // 2. Seed a session under "global" with matching directory.
      yield* Effect.sync(() => ensureGlobal())
      const id = legacySessionID()
      yield* Effect.sync(() => seed({ id, dir: tmp, project: ProjectID.global }))

      // 3. A first commit must not change the project ID.
      yield* Effect.promise(() => $`git commit --allow-empty -m "root"`.cwd(tmp).quiet())

      const { project: real, location: realLocation } = yield* projects.fromDirectory(tmp)
      expect(real.id).toBe(pre.id)
      expect(realLocation.id).toBe(preLocation.id)

      // 4. The matching session is claimed by the stable project.
      const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      expect(row).toBeDefined()
      expect(row!.project_id).toBe(real.id)
      expect(row!.location_id).toBe(realLocation.id)
    }),
  )

  it.live("migrates global sessions even when project row already exists", () =>
    Effect.gen(function* () {
      // 1. Create a repo with a commit — real project ID created immediately
      const tmp = yield* tmpdirScoped({ git: true })
      const projects = yield* Project.Service
      const { project } = yield* projects.fromDirectory(tmp)
      expect(project.id).not.toBe(ProjectID.global)

      // 2. Ensure "global" project row exists (as it would from a prior no-git session)
      yield* Effect.sync(() => ensureGlobal())

      // 3. Seed a session under "global" with matching directory.
      //    This simulates a session created before git init that wasn't
      //    present when the real project row was first created.
      const id = legacySessionID()
      yield* Effect.sync(() => seed({ id, dir: tmp, project: ProjectID.global }))

      // 4. Re-resolving an existing project still performs exact-directory claiming.
      yield* projects.fromDirectory(tmp)

      const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      expect(row).toBeDefined()
      expect(row!.project_id).toBe(project.id)
    }),
  )

  it.live("keeps scheduled tasks visible and runnable through git initialization", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const projects = yield* Project.Service
      const { project: before } = yield* projects.fromDirectory(tmp)
      const task = yield* ScheduledTaskRepository.create({
        projectID: before.id,
        directory: tmp,
        name: "Identity transition",
        prompt: "Run after git init",
        schedule: { kind: "at", at: Date.now() + 60_000 },
        executionMode: "new_session",
        agent: "build",
        model: { providerID: "test", modelID: "test" },
        unattended: true,
      })

      yield* Effect.promise(() => $`git init`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.name Test`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config user.email test@opencode.test`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git config commit.gpgsign false`.cwd(tmp).quiet())
      yield* Effect.promise(() => $`git commit --allow-empty -m root`.cwd(tmp).quiet())
      const { project: after } = yield* projects.fromDirectory(tmp)

      expect(after.id).toBe(before.id)
      expect((yield* ScheduledTaskRepository.list({ projectID: after.id })).map((item) => item.id)).toContain(task.id)
      expect((yield* ScheduledTaskRepository.update(task.id, { name: "Still manageable" }))?.name).toBe(
        "Still manageable",
      )
      const run = yield* ScheduledTaskRepository.claim({
        taskID: task.id,
        scheduledAt: Date.now(),
        ownerID: "identity-transition",
        leaseUntil: Date.now() + 60_000,
      })
      expect(run.type).toBe("claimed")
    }),
  )

  it.live("claims legacy sessions by each persisted directory", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped()
      const second = yield* tmpdirScoped()
      const projects = yield* Project.Service
      yield* Effect.sync(() => ensureGlobal())

      const firstSession = legacySessionID()
      const secondSession = legacySessionID()
      yield* Effect.sync(() => seed({ id: firstSession, dir: first, project: ProjectID.global }))
      yield* Effect.sync(() => seed({ id: secondSession, dir: second, project: ProjectID.global }))

      const claims = yield* projects.claimLegacy()
      expect(claims.sessions).toBe(2)

      const firstRow = Database.use((db) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, firstSession)).get(),
      )
      const secondRow = Database.use((db) =>
        db.select().from(SessionTable).where(eq(SessionTable.id, secondSession)).get(),
      )
      expect(firstRow?.project_id).toStartWith("dir:")
      expect(secondRow?.project_id).toStartWith("dir:")
      expect(firstRow?.project_id).not.toBe(secondRow?.project_id)

      expect((yield* projects.claimLegacy()).sessions).toBe(0)
    }),
  )

  it.live("does not claim sessions with empty directory", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const projects = yield* Project.Service
      const { project } = yield* projects.fromDirectory(tmp)
      expect(project.id).not.toBe(ProjectID.global)

      yield* Effect.sync(() => ensureGlobal())

      // Legacy sessions may lack a directory value.
      // Without a matching origin directory, they should remain global.
      const id = legacySessionID()
      yield* Effect.sync(() => seed({ id, dir: "", project: ProjectID.global }))

      yield* projects.fromDirectory(tmp)

      const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      expect(row).toBeDefined()
      expect(row!.project_id).toBe(ProjectID.global)
    }),
  )

  it.live("does not steal sessions from unrelated directories", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped({ git: true })
      const projects = yield* Project.Service
      const { project } = yield* projects.fromDirectory(tmp)
      expect(project.id).not.toBe(ProjectID.global)

      yield* Effect.sync(() => ensureGlobal())

      // Seed a session under "global" but for a DIFFERENT directory
      const id = legacySessionID()
      yield* Effect.sync(() => seed({ id, dir: "/some/other/dir", project: ProjectID.global }))

      yield* projects.fromDirectory(tmp)
      const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      expect(row).toBeDefined()
      // Should remain under "global" — not stolen
      expect(row!.project_id).toBe(ProjectID.global)
    }),
  )
})
