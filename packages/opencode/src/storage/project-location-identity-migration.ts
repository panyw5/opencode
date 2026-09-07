import { Path, type PathContext } from "@opencode-ai/core/util/path"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "db.project-location-identity-migration" })

export const migrationName = "20260907000000_project_location_identity_win32"

export type RawMigrationDatabase = {
  run: (sql: string, ...params: unknown[]) => unknown
  $client: {
    query?: unknown
    prepare?: unknown
  }
}

export type ProjectLocationIdentityMigrationResult = {
  skipped: boolean
  scanned: number
  normalized: number
  mergedLocations: number
  rewiredReferences: number
}

type LocationRow = {
  id: string
  projectID: string
  directory: string
  canonicalDirectory: string
  timeCreated: number
  timeUpdated: number
  timeLastSeen: number
  kind?: string
  vcsType?: string | null
  vcsState?: string
  worktreeRoot?: string | null
  gitCommonDir?: string | null
  marker?: string | null
  lifecycleState?: string
  lifecycleGeneration?: number
  deleteOperationID?: string | null
  timeUnavailable?: number | null
  timeDeleted?: number | null
}

type LocationReference = {
  table: string
  column: string
}

function rawAll(db: RawMigrationDatabase, sql: string, ...params: unknown[]) {
  const client = db.$client
  if (typeof client.query === "function") {
    const query = Reflect.apply(client.query, client, [sql]) as { all: (...params: unknown[]) => unknown[] }
    return query.all(...params) as Record<string, unknown>[]
  }
  if (typeof client.prepare === "function") {
    const prepare = Reflect.apply(client.prepare, client, [sql]) as { all: (...params: unknown[]) => unknown[] }
    return prepare.all(...params) as Record<string, unknown>[]
  }
  throw new Error("SQLite client does not support raw all queries")
}

function quoteIdentifier(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQLite identifier: ${identifier}`)
  return `"${identifier}"`
}

function quoteValue(value: unknown) {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function tableExists(db: RawMigrationDatabase, table: string) {
  return rawAll(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", table).length > 0
}

function tableColumns(db: RawMigrationDatabase, table: string) {
  return new Set(rawAll(db, `PRAGMA table_info(${quoteIdentifier(table)})`).map((row) => String(row.name)))
}

function sqliteTables(db: RawMigrationDatabase) {
  return rawAll(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .map((row) => String(row.name))
    .filter(Boolean)
}

function referencesToProjectLocation(db: RawMigrationDatabase): LocationReference[] {
  const references = new Map<string, LocationReference>()
  const tables = new Set(sqliteTables(db))
  const columnsByTable = new Map<string, Set<string>>()
  const columns = (table: string) => {
    const existing = columnsByTable.get(table)
    if (existing) return existing
    const result = tableColumns(db, table)
    columnsByTable.set(table, result)
    return result
  }
  const add = (table: string, column: string) => {
    if (table === "project_location" || !tables.has(table) || !columns(table).has(column)) return
    references.set(`${table}.${column}`, { table, column })
  }

  // Keep the known fork relationships explicit. The foreign-key scan below
  // also catches future location references without changing this migration.
  add("session", "location_id")
  add("scheduled_task", "location_id")
  add("workspace", "location_id")
  add("project_alias", "source_location_id")
  add("permission_scope", "location_id")

  for (const table of sqliteTables(db)) {
    if (table === "project_location") continue
    for (const foreignKey of rawAll(db, `PRAGMA foreign_key_list(${quoteIdentifier(table)})`)) {
      if (String(foreignKey.table) === "project_location" && String(foreignKey.to) === "id") {
        add(table, String(foreignKey.from))
      }
    }
  }

  return [...references.values()].sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`))
}

function numberValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function locationRows(db: RawMigrationDatabase): LocationRow[] {
  const columns = tableColumns(db, "project_location")
  const optional = [
    "time_created",
    "time_updated",
    "time_last_seen",
    "kind",
    "vcs_type",
    "vcs_state",
    "worktree_root",
    "git_common_dir",
    "marker",
    "lifecycle_state",
    "lifecycle_generation",
    "delete_operation_id",
    "time_unavailable",
    "time_deleted",
  ].filter((column) => columns.has(column))
  const selected = ["id", "project_id", "directory", "canonical_directory", ...optional]
  return rawAll(db, `SELECT ${selected.map(quoteIdentifier).join(", ")} FROM project_location`).map((row) => {
    const result: LocationRow = {
      id: String(row.id),
      projectID: String(row.project_id),
      directory: String(row.directory),
      canonicalDirectory: String(row.canonical_directory),
      timeCreated: numberValue(row.time_created),
      timeUpdated: numberValue(row.time_updated),
      timeLastSeen: numberValue(row.time_last_seen),
    }
    if (columns.has("kind")) result.kind = String(row.kind)
    if (columns.has("vcs_type")) result.vcsType = row.vcs_type === null ? null : String(row.vcs_type)
    if (columns.has("vcs_state")) result.vcsState = String(row.vcs_state)
    if (columns.has("worktree_root"))
      result.worktreeRoot = row.worktree_root === null ? null : String(row.worktree_root)
    if (columns.has("git_common_dir"))
      result.gitCommonDir = row.git_common_dir === null ? null : String(row.git_common_dir)
    if (columns.has("marker")) result.marker = row.marker === null ? null : String(row.marker)
    if (columns.has("lifecycle_state")) result.lifecycleState = String(row.lifecycle_state)
    if (columns.has("lifecycle_generation")) result.lifecycleGeneration = numberValue(row.lifecycle_generation)
    if (columns.has("delete_operation_id"))
      result.deleteOperationID = row.delete_operation_id === null ? null : String(row.delete_operation_id)
    if (columns.has("time_unavailable"))
      result.timeUnavailable = row.time_unavailable === null ? null : numberValue(row.time_unavailable)
    if (columns.has("time_deleted"))
      result.timeDeleted = row.time_deleted === null ? null : numberValue(row.time_deleted)
    return result
  })
}

function lifecycleRank(state: string | undefined) {
  if (state === "available") return 4
  if (state === "unavailable") return 3
  if (state === "deleting") return 2
  if (state === "deleted") return 1
  return 0
}

function survivorCompare(a: LocationRow, b: LocationRow) {
  const aLifecycle = lifecycleRank(a.lifecycleState)
  const bLifecycle = lifecycleRank(b.lifecycleState)
  if (aLifecycle !== bLifecycle) return bLifecycle - aLifecycle
  const aReady = a.vcsState === "ready" ? 1 : 0
  const bReady = b.vcsState === "ready" ? 1 : 0
  if (aReady !== bReady) return bReady - aReady
  const aGit = a.vcsType === "git" ? 1 : 0
  const bGit = b.vcsType === "git" ? 1 : 0
  if (aGit !== bGit) return bGit - aGit
  const aMarker = a.marker ? 1 : 0
  const bMarker = b.marker ? 1 : 0
  if (aMarker !== bMarker) return bMarker - aMarker
  const aScore = Math.max(a.timeLastSeen, a.timeUpdated, a.timeCreated)
  const bScore = Math.max(b.timeLastSeen, b.timeUpdated, b.timeCreated)
  if (aScore !== bScore) return bScore - aScore
  return a.id.localeCompare(b.id)
}

function valueRank(field: "kind" | "vcsState", value: string | undefined) {
  if (field === "kind") {
    if (value === "git_main" || value === "git_worktree") return 4
    if (value === "git_clone") return 3
    if (value === "directory") return 2
    return value ? 1 : 0
  }
  if (value === "ready") return 5
  if (value === "unborn") return 4
  if (value === "unavailable") return 3
  if (value === "error") return 2
  if (value === "none") return 1
  return value ? 1 : 0
}

function bestValue<T>(
  rows: LocationRow[],
  read: (row: LocationRow) => T | null | undefined,
  rank?: (value: T) => number,
) {
  return [...rows]
    .sort((a, b) => {
      const aValue = read(a)
      const bValue = read(b)
      const aPresent = aValue === null || aValue === undefined || aValue === "" ? 0 : 1
      const bPresent = bValue === null || bValue === undefined || bValue === "" ? 0 : 1
      if (aPresent !== bPresent) return bPresent - aPresent
      if (rank && aPresent && bPresent) {
        const aRank = rank(aValue as T)
        const bRank = rank(bValue as T)
        if (aRank !== bRank) return bRank - aRank
      }
      return survivorCompare(a, b)
    })
    .map(read)
    .find((value) => value !== null && value !== undefined && value !== "")
}

function mergeLocationMetadata(rows: LocationRow[], pathContext: PathContext) {
  const lifecycleState = [...rows].sort((a, b) => lifecycleRank(b.lifecycleState) - lifecycleRank(a.lifecycleState))[0]
    ?.lifecycleState
  const logicalValue = (value: string | null | undefined) =>
    value === null || value === undefined ? value : Path.logical(value, pathContext)
  const bestLogicalValue = (read: (row: LocationRow) => string | null | undefined) =>
    logicalValue(bestValue(rows, read, (value) => String(value).length))
  const update: Record<string, unknown> = {
    directory: Path.logical([...rows].sort(survivorCompare)[0]?.directory ?? "", pathContext),
    canonical_directory: Path.identity([...rows].sort(survivorCompare)[0]?.directory ?? "", pathContext),
    kind: bestValue(
      rows,
      (row) => row.kind,
      (value) => valueRank("kind", value),
    ),
    vcs_type: bestValue(rows, (row) => row.vcsType),
    vcs_state: bestValue(
      rows,
      (row) => row.vcsState,
      (value) => valueRank("vcsState", value),
    ),
    worktree_root: bestLogicalValue((row) => row.worktreeRoot),
    git_common_dir: bestLogicalValue((row) => row.gitCommonDir),
    marker: bestLogicalValue((row) => row.marker),
    lifecycle_state: lifecycleState,
    lifecycle_generation: Math.max(...rows.map((row) => row.lifecycleGeneration ?? 0)),
    time_created: Math.min(...rows.map((row) => row.timeCreated)),
    time_updated: Math.max(...rows.map((row) => row.timeUpdated)),
    time_last_seen: Math.max(...rows.map((row) => row.timeLastSeen)),
  }

  if (lifecycleState === "available") {
    update.delete_operation_id = null
    update.time_unavailable = null
    update.time_deleted = null
  } else if (lifecycleState === "unavailable") {
    update.delete_operation_id = null
    update.time_unavailable = Math.max(...rows.map((row) => row.timeUnavailable ?? 0)) || null
    update.time_deleted = null
  } else if (lifecycleState === "deleting") {
    update.delete_operation_id =
      bestValue(
        rows,
        (row) => row.deleteOperationID,
        (value) => String(value).length,
      ) ?? null
    update.time_unavailable = Math.max(...rows.map((row) => row.timeUnavailable ?? 0)) || null
    update.time_deleted = null
  } else if (lifecycleState === "deleted") {
    update.delete_operation_id = null
    update.time_unavailable = null
    update.time_deleted = Math.max(...rows.map((row) => row.timeDeleted ?? 0)) || null
  }
  return update
}

function skipResult(): ProjectLocationIdentityMigrationResult {
  return { skipped: true, scanned: 0, normalized: 0, mergedLocations: 0, rewiredReferences: 0 }
}

/**
 * Normalize project_location.canonical_directory to Path.identity and merge
 * equivalent locations belonging to the same project. The caller owns the
 * SQLite transaction; upstream migration invokes this from BEGIN IMMEDIATE.
 */
export function migrateProjectLocationIdentity(
  db: RawMigrationDatabase,
  pathContext: PathContext,
): ProjectLocationIdentityMigrationResult {
  if (pathContext.platform !== "win32" || pathContext.kind !== "local-filesystem") {
    log.info("project location identity migration skipped", {
      migration: migrationName,
      platform: pathContext.platform,
      kind: pathContext.kind,
      reason: "not-win32-local-filesystem",
    })
    return skipResult()
  }
  if (!tableExists(db, "project_location")) {
    log.info("project location identity migration skipped", { migration: migrationName, reason: "table-missing" })
    return skipResult()
  }

  const rows = locationRows(db)
  const groups = new Map<string, LocationRow[]>()
  for (const row of rows) {
    const identity = Path.identity(row.directory, pathContext) as string
    const group = groups.get(identity)
    if (group) group.push(row)
    else groups.set(identity, [row])
  }

  log.info("project location identity migration scan", {
    migration: migrationName,
    platform: pathContext.platform,
    kind: pathContext.kind,
    locations: rows.length,
    identities: groups.size,
  })

  const conflicts = [...groups.entries()].filter(([, group]) => new Set(group.map((row) => row.projectID)).size > 1)
  if (conflicts.length > 0) {
    const details = conflicts.map(([identity, group]) => ({
      identity,
      locations: group.map((row) => ({ id: row.id, projectID: row.projectID, directory: row.directory })),
    }))
    log.error("project location identity migration rejected cross-project conflict", {
      migration: migrationName,
      conflicts: details,
    })
    throw new Error(
      `Project location identity conflict across projects: ${details.map((item) => item.identity).join(", ")}`,
    )
  }

  const references = referencesToProjectLocation(db)
  const locationColumns = tableColumns(db, "project_location")
  let normalized = 0
  let mergedLocations = 0
  let rewiredReferences = 0

  // Remove duplicate rows before writing identities so the existing global
  // unique index on canonical_directory cannot reject an otherwise safe merge.
  for (const [identity, group] of groups) {
    const ordered = [...group].sort(survivorCompare)
    const survivor = ordered[0]
    if (!survivor) continue

    for (const duplicate of ordered.slice(1)) {
      log.info("project location identity migration rewiring references", {
        migration: migrationName,
        identity,
        survivorID: survivor.id,
        duplicateID: duplicate.id,
        references: references.map((reference) => `${reference.table}.${reference.column}`),
      })
      for (const reference of references) {
        db.run(
          `UPDATE ${quoteIdentifier(reference.table)} SET ${quoteIdentifier(reference.column)} = ${quoteValue(survivor.id)} WHERE ${quoteIdentifier(reference.column)} = ${quoteValue(duplicate.id)}`,
        )
        const changed = rawAll(db, "SELECT changes() AS count")[0]
        rewiredReferences += numberValue(changed?.count)
      }
      db.run(`DELETE FROM project_location WHERE id = ${quoteValue(duplicate.id)}`)
      mergedLocations++
      log.info("project location identity migration location merged", {
        migration: migrationName,
        identity,
        survivorID: survivor.id,
        duplicateID: duplicate.id,
      })
    }

    const merged = mergeLocationMetadata(group, pathContext)
    const changes = Object.entries(merged).filter(([column, value]) => {
      if (!locationColumns.has(column) || value === undefined) return false
      const current =
        column === "directory"
          ? survivor.directory
          : column === "canonical_directory"
            ? survivor.canonicalDirectory
            : column === "kind"
              ? survivor.kind
              : column === "vcs_type"
                ? survivor.vcsType
                : column === "vcs_state"
                  ? survivor.vcsState
                  : column === "worktree_root"
                    ? survivor.worktreeRoot
                    : column === "git_common_dir"
                      ? survivor.gitCommonDir
                      : column === "marker"
                        ? survivor.marker
                        : column === "lifecycle_state"
                          ? survivor.lifecycleState
                          : column === "lifecycle_generation"
                            ? survivor.lifecycleGeneration
                            : column === "delete_operation_id"
                              ? survivor.deleteOperationID
                              : column === "time_unavailable"
                                ? survivor.timeUnavailable
                                : column === "time_deleted"
                                  ? survivor.timeDeleted
                                  : column === "time_created"
                                    ? survivor.timeCreated
                                    : column === "time_updated"
                                      ? survivor.timeUpdated
                                      : column === "time_last_seen"
                                        ? survivor.timeLastSeen
                                        : undefined
      return current !== value
    })
    if (changes.length > 0) {
      const assignments = changes
        .map(([column, value]) => `${quoteIdentifier(column)} = ${quoteValue(value)}`)
        .join(", ")
      db.run(`UPDATE project_location SET ${assignments} WHERE id = ${quoteValue(survivor.id)}`)
      if (changes.some(([column]) => column === "canonical_directory")) normalized++
      log.info("project location identity migration metadata merged", {
        migration: migrationName,
        identity,
        survivorID: survivor.id,
        fields: changes.map(([column]) => column),
      })
    }
  }

  log.info("project location identity migration complete", {
    migration: migrationName,
    scanned: rows.length,
    normalized,
    mergedLocations,
    rewiredReferences,
  })
  return { skipped: false, scanned: rows.length, normalized, mergedLocations, rewiredReferences }
}

export * as ProjectLocationIdentityMigration from "./project-location-identity-migration"
