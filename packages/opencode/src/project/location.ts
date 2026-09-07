import { Database } from "@/storage/db"
import { and, eq } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { Path, type PathContext } from "@opencode-ai/core/util/path"
import { ProjectLocationTable } from "./location.sql"
import type {
  ProjectLocationKind,
  ProjectLocationLifecycleState,
  ProjectLocationVcsState,
  ProjectLocationVcsType,
} from "./location.sql"
import { LocationID, type ProjectID } from "./schema"
import { localPathContext } from "./instance-context"

const log = Log.create({ service: "project-location" })

type Row = typeof ProjectLocationTable.$inferSelect

export interface Info {
  id: LocationID
  projectID: ProjectID
  directory: string
  directoryIdentity: string
  kind: ProjectLocationKind
  vcsType?: ProjectLocationVcsType
  vcsState: ProjectLocationVcsState
  worktreeRoot?: string
  gitCommonDir?: string
  marker?: string
  lifecycle: {
    state: ProjectLocationLifecycleState
    generation: number
    deleteOperationID?: string
    timeUnavailable?: number
    timeDeleted?: number
  }
  time: {
    created: number
    updated: number
    lastSeen: number
  }
}

export interface UpsertInput {
  projectID: ProjectID
  directory: string
  pathContext?: PathContext
  kind: ProjectLocationKind
  vcsType?: ProjectLocationVcsType
  vcsState: ProjectLocationVcsState
  worktreeRoot?: string
  gitCommonDir?: string
  marker?: string
}

export function fromRow(row: Row): Info {
  return {
    id: row.id,
    projectID: row.project_id,
    directory: row.directory,
    directoryIdentity: row.canonical_directory,
    kind: row.kind,
    vcsType: row.vcs_type ?? undefined,
    vcsState: row.vcs_state,
    worktreeRoot: row.worktree_root ?? undefined,
    gitCommonDir: row.git_common_dir ?? undefined,
    marker: row.marker ?? undefined,
    lifecycle: {
      state: row.lifecycle_state,
      generation: row.lifecycle_generation,
      deleteOperationID: row.delete_operation_id ?? undefined,
      timeUnavailable: row.time_unavailable ?? undefined,
      timeDeleted: row.time_deleted ?? undefined,
    },
    time: {
      created: row.time_created,
      updated: row.time_updated,
      lastSeen: row.time_last_seen,
    },
  }
}

function pathParts(directory: string, pathContext: PathContext = localPathContext) {
  const logical = Path.logical(directory, pathContext) as string
  return { directory: logical, identity: Path.identity(logical, pathContext) as string }
}

export function getByDirectory(directory: string, pathContext: PathContext = localPathContext): Info | undefined {
  const parts = pathParts(directory, pathContext)
  const row = Database.use((db) =>
    db
      .select()
      .from(ProjectLocationTable)
      .where(eq(ProjectLocationTable.canonical_directory, parts.identity))
      .get(),
  )
  return row ? fromRow(row) : undefined
}

export function getByID(locationID: LocationID): Info | undefined {
  const row = Database.use((db) =>
    db
      .select()
      .from(ProjectLocationTable)
      .where(eq(ProjectLocationTable.id, locationID))
      .get(),
  )
  return row ? fromRow(row) : undefined
}

export function listByLifecycleState(state: ProjectLocationLifecycleState): Info[] {
  return Database.use((db) =>
    db
      .select()
      .from(ProjectLocationTable)
      .where(eq(ProjectLocationTable.lifecycle_state, state))
      .all(),
  ).map(fromRow)
}

export function markDeleting(input: {
  directory: string
  operationID: string
  pathContext?: PathContext
}): Info | undefined {
  const now = Date.now()
  const parts = pathParts(input.directory, input.pathContext)
  return Database.transaction(
    (db) => {
      const existing = db
        .select()
        .from(ProjectLocationTable)
        .where(eq(ProjectLocationTable.canonical_directory, parts.identity))
        .get()
      if (!existing) return undefined
      const row = db
        .update(ProjectLocationTable)
        .set({
          lifecycle_state: "deleting",
          lifecycle_generation: existing.lifecycle_generation + 1,
          delete_operation_id: input.operationID,
          time_updated: now,
        })
        .where(eq(ProjectLocationTable.id, existing.id))
        .returning()
        .get()
      return fromRow(row)
    },
    { behavior: "immediate" },
  )
}

export function markDeleted(input: { directory: string; pathContext?: PathContext }): Info | undefined {
  const now = Date.now()
  const parts = pathParts(input.directory, input.pathContext)
  const row = Database.use((db) =>
    db
      .update(ProjectLocationTable)
      .set({
        lifecycle_state: "deleted",
        time_deleted: now,
        time_updated: now,
      })
      .where(eq(ProjectLocationTable.canonical_directory, parts.identity))
      .returning()
      .get(),
  )
  return row ? fromRow(row) : undefined
}

export function markAvailable(input: { directory: string; pathContext?: PathContext }): Info | undefined {
  const now = Date.now()
  const parts = pathParts(input.directory, input.pathContext)
  const row = Database.use((db) =>
    db
      .update(ProjectLocationTable)
      .set({
        lifecycle_state: "available",
        delete_operation_id: null,
        time_updated: now,
      })
      .where(
        and(
          eq(ProjectLocationTable.canonical_directory, parts.identity),
          eq(ProjectLocationTable.lifecycle_state, "unavailable"),
        ),
      )
      .returning()
      .get(),
  )
  return row ? fromRow(row) : undefined
}

export function uniqueProjectByGitCommonDir(gitCommonDir: string): ProjectID | undefined {
  const rows = Database.use((db) =>
    db
      .select({ projectID: ProjectLocationTable.project_id, gitCommonDir: ProjectLocationTable.git_common_dir })
      .from(ProjectLocationTable)
      .all(),
  )
  const projects = new Set(
    rows
      .filter((row) => row.gitCommonDir && Path.equals(row.gitCommonDir, gitCommonDir, localPathContext))
      .map((row) => row.projectID),
  )
  return projects.size === 1 ? projects.values().next().value : undefined
}

export function upsert(input: UpsertInput): Info {
  const parts = pathParts(input.directory, input.pathContext)
  return Database.transaction(
    (db) => {
      const now = Date.now()
      const existing = db
        .select()
        .from(ProjectLocationTable)
        .where(eq(ProjectLocationTable.canonical_directory, parts.identity))
        .get()
      if (existing) {
        if (existing.project_id !== input.projectID) {
          log.error("project location identity conflict", {
            directory: parts.directory,
            directoryIdentity: parts.identity,
            existingLocationID: existing.id,
            existingProjectID: existing.project_id,
            requestedProjectID: input.projectID,
          })
          throw new Error(
            `ProjectLocation identity conflict: directory=${parts.directory} identity=${parts.identity} ` +
              `existingProjectID=${existing.project_id} requestedProjectID=${input.projectID}`,
          )
        }
        const row = db
          .update(ProjectLocationTable)
          .set({
            project_id: input.projectID,
            directory: parts.directory,
            kind: input.kind,
            vcs_type: input.vcsType ?? null,
            vcs_state: input.vcsState,
            worktree_root: input.worktreeRoot ?? null,
            git_common_dir: input.gitCommonDir ?? null,
            marker: input.marker ?? null,
            time_updated: now,
            time_last_seen: now,
          })
          .where(eq(ProjectLocationTable.id, existing.id))
          .returning()
          .get()
        return fromRow(row)
      }

      const row = db
        .insert(ProjectLocationTable)
        .values({
          id: LocationID.ascending(),
          project_id: input.projectID,
          directory: parts.directory,
          canonical_directory: parts.identity,
          kind: input.kind,
          vcs_type: input.vcsType ?? null,
          vcs_state: input.vcsState,
          worktree_root: input.worktreeRoot ?? null,
          git_common_dir: input.gitCommonDir ?? null,
          marker: input.marker ?? null,
          time_created: now,
          time_updated: now,
          time_last_seen: now,
        })
        .returning()
        .get()
      return fromRow(row)
    },
    { behavior: "immediate" },
  )
}

export function markUnavailableByDirectory(input: {
  projectID: ProjectID
  directory: string
  pathContext?: PathContext
}): void {
  const now = Date.now()
  const parts = pathParts(input.directory, input.pathContext)
  Database.use((db) =>
    db
      .update(ProjectLocationTable)
      .set({ vcs_state: "unavailable", time_updated: now, time_last_seen: now })
      .where(
        and(
          eq(ProjectLocationTable.project_id, input.projectID),
          eq(ProjectLocationTable.canonical_directory, parts.identity),
        ),
      )
      .run(),
  )
}

export * as ProjectLocation from "./location"
