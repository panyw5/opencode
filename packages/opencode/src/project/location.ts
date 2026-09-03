import { Database } from "@/storage/db"
import { directorySqlEq } from "@/util/directory-sql"
import { and, eq } from "drizzle-orm"
import { ProjectLocationTable } from "./location.sql"
import type {
  ProjectLocationKind,
  ProjectLocationLifecycleState,
  ProjectLocationVcsState,
  ProjectLocationVcsType,
} from "./location.sql"
import { LocationID, type ProjectID } from "./schema"

type Row = typeof ProjectLocationTable.$inferSelect

export interface Info {
  id: LocationID
  projectID: ProjectID
  directory: string
  canonicalDirectory: string
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
  canonicalDirectory: string
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
    canonicalDirectory: row.canonical_directory,
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

export function getByCanonicalDirectory(directory: string): Info | undefined {
  const row = Database.use((db) =>
    db
      .select()
      .from(ProjectLocationTable)
      .where(directorySqlEq(ProjectLocationTable.canonical_directory, directory))
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
}): Info | undefined {
  const now = Date.now()
  return Database.transaction(
    (db) => {
      const existing = db
        .select()
        .from(ProjectLocationTable)
        .where(directorySqlEq(ProjectLocationTable.canonical_directory, input.directory))
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

export function markDeleted(input: { directory: string }): Info | undefined {
  const now = Date.now()
  const row = Database.use((db) =>
    db
      .update(ProjectLocationTable)
      .set({
        lifecycle_state: "deleted",
        time_deleted: now,
        time_updated: now,
      })
      .where(directorySqlEq(ProjectLocationTable.canonical_directory, input.directory))
      .returning()
      .get(),
  )
  return row ? fromRow(row) : undefined
}

export function markAvailable(input: { directory: string }): Info | undefined {
  const now = Date.now()
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
          directorySqlEq(ProjectLocationTable.canonical_directory, input.directory),
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
      .select({ projectID: ProjectLocationTable.project_id })
      .from(ProjectLocationTable)
      .where(directorySqlEq(ProjectLocationTable.git_common_dir, gitCommonDir))
      .all(),
  )
  const projects = new Set(rows.map((row) => row.projectID))
  return projects.size === 1 ? projects.values().next().value : undefined
}

export function upsert(input: UpsertInput): Info {
  return Database.transaction(
    (db) => {
      const now = Date.now()
      const existing = db
        .select()
        .from(ProjectLocationTable)
        .where(directorySqlEq(ProjectLocationTable.canonical_directory, input.canonicalDirectory))
        .get()
      if (existing) {
        const row = db
          .update(ProjectLocationTable)
          .set({
            project_id: input.projectID,
            directory: input.directory,
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
          directory: input.directory,
          canonical_directory: input.canonicalDirectory,
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

export function markUnavailableByDirectory(input: { projectID: ProjectID; directory: string }): void {
  const now = Date.now()
  Database.use((db) =>
    db
      .update(ProjectLocationTable)
      .set({ vcs_state: "unavailable", time_updated: now, time_last_seen: now })
      .where(
        and(
          eq(ProjectLocationTable.project_id, input.projectID),
          directorySqlEq(ProjectLocationTable.canonical_directory, input.directory),
        ),
      )
      .run(),
  )
}

export * as ProjectLocation from "./location"
