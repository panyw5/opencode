import { describe, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { InstanceState } from "@/effect/instance-state"
import { ProjectTask } from "@/project-task/service"
import * as ProjectTaskRepository from "@/project-task/repository"
import { ProjectTaskTable } from "@/project-task/project-task.sql"
import {
  descriptionRelativePath,
  INITIAL_PROGRESS_CONTENT,
  progressRelativePath,
} from "@/project-task/description-file"
import { ProjectTaskID } from "@/project-task/schema"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"

const it = testEffect(ProjectTask.defaultLayer)

describe("ProjectTask service reads", () => {
  it.instance("creates a progress record with an entry format for a new task", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const service = yield* ProjectTask.Service
      const task = yield* service.create({ title: "New task", description: "Task brief" })
      const description = path.join(ctx.worktree, descriptionRelativePath(task.id))
      const progress = path.join(ctx.worktree, progressRelativePath(task.id))

      expect(existsSync(description)).toBe(true)
      expect(existsSync(progress)).toBe(true)
      const progressContent = readFileSync(progress, "utf8")
      expect(progressContent).toBe(INITIAL_PROGRESS_CONTENT)
      expect(progressContent).toMatch(/^<!--/)
      expect(progressContent).toContain("This file is append-only")
      expect(progressContent).toContain("current session ID")
      expect(progressContent).toContain("## Progress")
      expect(progressContent).toContain("## Relevant files")
    }),
  )

  it.instance("list does not migrate a legacy description until get explicitly hydrates it", () =>
    Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      const service = yield* ProjectTask.Service
      const id = ProjectTaskID.ascending()
      const relative = descriptionRelativePath(id)
      const absolute = path.join(ctx.worktree, relative)
      const now = Date.now()
      yield* ProjectTaskRepository.listRows({ projectID: ctx.project.id })
      Database.use((db) =>
        db
          .insert(ProjectTaskTable)
          .values({
            id,
            project_id: ctx.project.id,
            title: "Legacy description",
            description: "legacy body",
            description_path: null,
            status: "open",
            time_created: now,
            time_updated: now,
          })
          .run(),
      )

      const listed = yield* service.list()
      expect(listed[0]?.description).toBe("legacy body")
      expect(existsSync(absolute)).toBe(false)
      expect(
        Database.use((db) =>
          db.select({ path: ProjectTaskTable.description_path }).from(ProjectTaskTable).where(eq(ProjectTaskTable.id, id)).get(),
        )?.path,
      ).toBeNull()

      const hydrated = yield* service.get(id)
      expect(hydrated.description).toBe("legacy body")
      expect(existsSync(absolute)).toBe(true)
    }),
  )
})
