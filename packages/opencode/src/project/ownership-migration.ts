import { Database } from "@/storage/db"
import { directorySqlEq } from "@/util/directory-sql"
import { DataMigrationTable } from "@/data-migration.sql"
import { ProjectTaskTable } from "@/project-task/project-task.sql"
import { ScheduledTaskTable } from "@/scheduled-task/scheduled-task.sql"
import { SessionTable } from "@/session/session.sql"
import { WorkspaceTable } from "@/control-plane/workspace.sql"
import * as Log from "@opencode-ai/core/util/log"
import { and, eq, isNotNull, sql } from "drizzle-orm"
import { ProjectAliasTable, ProjectLocationTable } from "./location.sql"
import { ProjectTable } from "./project.sql"

const log = Log.create({ service: "project-ownership-migration" })

export const migrationName = "project_ownership_duplicate_worktree_v1"

export interface Result {
  completed: boolean
  candidates: number
  migratedProjects: number
  skippedProjects: number
  sessions: number
  scheduledTasks: number
  workspaces: number
}

const emptyResult = (completed: boolean): Result => ({
  completed,
  candidates: 0,
  migratedProjects: 0,
  skippedProjects: 0,
  sessions: 0,
  scheduledTasks: 0,
  workspaces: 0,
})

function pathKey(value: string) {
  const normalized = value.replaceAll("\\", "/")
  if (/^\/+$/i.test(normalized)) return "/"
  return normalized.replace(/\/+$/, "")
}

/**
 * Repairs the narrow legacy split where one canonical checkout has both an old
 * `dir:*` project and a newer, high-confidence Git-backed project/location.
 *
 * The completion marker is committed in the same IMMEDIATE transaction as the
 * ownership updates. A crash, lock failure, or rejected write therefore leaves
 * no marker and the next application start can safely retry the whole repair.
 */
export function runDuplicateWorktreeOwnershipMigration(): Result {
  return Database.transaction(
    (db) => {
      const completed = db
        .select({ name: DataMigrationTable.name })
        .from(DataMigrationTable)
        .where(eq(DataMigrationTable.name, migrationName))
        .get()
      if (completed) {
        log.info("project ownership migration already completed", { name: migrationName })
        return emptyResult(true)
      }

      const result = emptyResult(false)
      const projects = db.select().from(ProjectTable).all()
      const locations = db.select().from(ProjectLocationTable).all()
      const aliases = db.select().from(ProjectAliasTable).all()
      const projectsByWorktree = new Map<string, typeof projects>()

      for (const project of projects) {
        const key = pathKey(project.worktree)
        const list = projectsByWorktree.get(key)
        if (list) list.push(project)
        else projectsByWorktree.set(key, [project])
      }

      log.info("project ownership migration scan started", {
        name: migrationName,
        projects: projects.length,
        locations: locations.length,
      })

      for (const location of locations) {
        if (location.vcs_type !== "git" || !location.marker) continue
        const canonical = pathKey(location.canonical_directory)
        const target = projects.find((project) => project.id === location.project_id)
        if (!target || pathKey(target.worktree) !== canonical) continue

        const marker = aliases.some(
          (alias) =>
            alias.project_id === target.id &&
            alias.source_location_id === location.id &&
            alias.kind === "git_marker" &&
            alias.confidence === "high",
        )
        if (!marker) {
          log.warn("project ownership migration candidate rejected", {
            targetProjectID: target.id,
            locationID: location.id,
            canonicalDirectory: location.canonical_directory,
            reason: "missing-high-confidence-git-marker",
          })
          continue
        }

        const sources = (projectsByWorktree.get(canonical) ?? []).filter(
          (project) => project.id !== target.id && project.id.startsWith("dir:"),
        )
        if (sources.length === 0) continue
        result.candidates += sources.length

        if (sources.length !== 1) {
          result.skippedProjects += sources.length
          log.warn("project ownership migration candidate rejected", {
            targetProjectID: target.id,
            locationID: location.id,
            canonicalDirectory: location.canonical_directory,
            sourceProjectIDs: sources.map((source) => source.id),
            reason: "ambiguous-legacy-sources",
          })
          continue
        }

        const source = sources.at(0)
        if (!source) continue
        const sourceLocations = locations.filter((item) => item.project_id === source.id)
        const sessionDirectories = db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.project_id, source.id))
          .all()
        const taskDirectories = db
          .select({ directory: ScheduledTaskTable.directory })
          .from(ScheduledTaskTable)
          .where(eq(ScheduledTaskTable.project_id, source.id))
          .all()
        const workspaceDirectories = db
          .select({ directory: WorkspaceTable.directory })
          .from(WorkspaceTable)
          .where(and(eq(WorkspaceTable.project_id, source.id), isNotNull(WorkspaceTable.directory)))
          .all()
        const projectTasks = db
          .select({ id: ProjectTaskTable.id })
          .from(ProjectTaskTable)
          .where(eq(ProjectTaskTable.project_id, source.id))
          .all()
        const mountedSessions = db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(and(eq(SessionTable.project_id, source.id), isNotNull(SessionTable.mounted_task_id)))
          .all()
        const foreignDirectories = [...sessionDirectories, ...taskDirectories, ...workspaceDirectories].filter(
          (item) => {
            if (!item.directory) return false
            return pathKey(item.directory) !== canonical
          },
        )

        if (
          sourceLocations.length > 0 ||
          foreignDirectories.length > 0 ||
          projectTasks.length > 0 ||
          mountedSessions.length > 0
        ) {
          result.skippedProjects++
          log.warn("project ownership migration candidate rejected", {
            sourceProjectID: source.id,
            targetProjectID: target.id,
            locationID: location.id,
            canonicalDirectory: location.canonical_directory,
            sourceLocations: sourceLocations.length,
            foreignDirectories: foreignDirectories.length,
            projectTasks: projectTasks.length,
            mountedSessions: mountedSessions.length,
            reason:
              sourceLocations.length > 0
                ? "legacy-project-has-location"
                : foreignDirectories.length > 0
                  ? "legacy-project-spans-directories"
                  : "legacy-project-has-project-scoped-state",
          })
          continue
        }

        log.info("project ownership migration candidate accepted", {
          sourceProjectID: source.id,
          targetProjectID: target.id,
          locationID: location.id,
          canonicalDirectory: location.canonical_directory,
          sessions: sessionDirectories.length,
          scheduledTasks: taskDirectories.length,
          workspaces: workspaceDirectories.length,
        })

        result.sessions += db
          .update(SessionTable)
          .set({
            project_id: target.id,
            location_id: location.id,
            time_updated: sql`${SessionTable.time_updated}`,
          })
          .where(
            and(
              eq(SessionTable.project_id, source.id),
              directorySqlEq(SessionTable.directory, location.canonical_directory),
            ),
          )
          .returning({ id: SessionTable.id })
          .all().length
        result.scheduledTasks += db
          .update(ScheduledTaskTable)
          .set({
            project_id: target.id,
            location_id: location.id,
            time_updated: sql`${ScheduledTaskTable.time_updated}`,
          })
          .where(
            and(
              eq(ScheduledTaskTable.project_id, source.id),
              directorySqlEq(ScheduledTaskTable.directory, location.canonical_directory),
            ),
          )
          .returning({ id: ScheduledTaskTable.id })
          .all().length
        result.workspaces += db
          .update(WorkspaceTable)
          .set({ project_id: target.id, location_id: location.id })
          .where(
            and(
              eq(WorkspaceTable.project_id, source.id),
              directorySqlEq(WorkspaceTable.directory, location.canonical_directory),
            ),
          )
          .returning({ id: WorkspaceTable.id })
          .all().length
        result.migratedProjects++
      }

      db.insert(DataMigrationTable)
        .values({ name: migrationName, time_completed: Date.now() })
        .onConflictDoNothing()
        .run()
      result.completed = true
      log.info("project ownership migration completed", { name: migrationName, ...result })
      return result
    },
    { behavior: "immediate", operation: migrationName },
  )
}

export * as ProjectOwnershipMigration from "./ownership-migration"
