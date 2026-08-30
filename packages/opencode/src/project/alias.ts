import { Database } from "@/storage/db"
import { and, eq } from "drizzle-orm"
import { ProjectAliasTable } from "./location.sql"
import type { ProjectAliasConfidence, ProjectAliasKind } from "./location.sql"
import { ProjectAliasID, type LocationID, type ProjectID } from "./schema"

type Row = typeof ProjectAliasTable.$inferSelect

export interface Info {
  id: ProjectAliasID
  projectID: ProjectID
  kind: ProjectAliasKind
  value: string
  confidence: ProjectAliasConfidence
  sourceLocationID?: LocationID
  time: {
    created: number
    updated: number
    lastSeen: number
  }
}

export interface UpsertInput {
  projectID: ProjectID
  kind: ProjectAliasKind
  value: string
  confidence: ProjectAliasConfidence
  sourceLocationID?: LocationID
}

export function fromRow(row: Row): Info {
  return {
    id: row.id,
    projectID: row.project_id,
    kind: row.kind,
    value: row.value,
    confidence: row.confidence,
    sourceLocationID: row.source_location_id ?? undefined,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      lastSeen: row.time_last_seen,
    },
  }
}

export function normalizeRemoteUrl(input: string): string | undefined {
  const value = input.trim()
  if (!value) return

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    try {
      const url = new URL(value)
      if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return
      const port = url.port ? `:${url.port}` : ""
      return normalizeRemoteParts(`${url.hostname.toLowerCase()}${port}`, url.pathname)
    } catch {
      return
    }
  }

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value)
  if (scp && !/^[A-Za-z]:[\\/]/.test(value)) return normalizeRemoteParts(scp[1], scp[2])
}

function normalizeRemoteParts(host: string, inputPath: string): string | undefined {
  const path = inputPath
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
  if (!host || !path) return
  return `${host.toLowerCase()}/${path}`
}

export function upsert(input: UpsertInput): Info {
  return Database.transaction(
    (db) => {
      const now = Date.now()
      const existing = db
        .select()
        .from(ProjectAliasTable)
        .where(
          and(
            eq(ProjectAliasTable.project_id, input.projectID),
            eq(ProjectAliasTable.kind, input.kind),
            eq(ProjectAliasTable.value, input.value),
          ),
        )
        .get()
      if (existing) {
        const row = db
          .update(ProjectAliasTable)
          .set({
            confidence: input.confidence,
            source_location_id: input.sourceLocationID ?? existing.source_location_id,
            time_updated: now,
            time_last_seen: now,
          })
          .where(eq(ProjectAliasTable.id, existing.id))
          .returning()
          .get()
        return fromRow(row)
      }

      const row = db
        .insert(ProjectAliasTable)
        .values({
          id: ProjectAliasID.ascending(),
          project_id: input.projectID,
          kind: input.kind,
          value: input.value,
          confidence: input.confidence,
          source_location_id: input.sourceLocationID,
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

export function listByValue(kind: ProjectAliasKind, value: string): Info[] {
  return Database.use((db) =>
    db
      .select()
      .from(ProjectAliasTable)
      .where(and(eq(ProjectAliasTable.kind, kind), eq(ProjectAliasTable.value, value)))
      .all()
      .map(fromRow),
  )
}

export function listByProject(projectID: ProjectID): Info[] {
  return Database.use((db) =>
    db.select().from(ProjectAliasTable).where(eq(ProjectAliasTable.project_id, projectID)).all().map(fromRow),
  )
}

export function uniqueProject(kind: ProjectAliasKind, value: string): ProjectID | undefined {
  const projects = new Set(listByValue(kind, value).map((item) => item.projectID))
  return projects.size === 1 ? projects.values().next().value : undefined
}

export * as ProjectAlias from "./alias"
