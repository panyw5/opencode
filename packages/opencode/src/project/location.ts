import { Database } from "@/storage/db"
import { directorySqlEq } from "@/util/directory-sql"
import { and, eq } from "drizzle-orm"
import { ProjectLocationTable } from "./location.sql"
import type { ProjectLocationKind, ProjectLocationVcsState, ProjectLocationVcsType } from "./location.sql"
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
