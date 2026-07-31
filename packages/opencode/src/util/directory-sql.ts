import { sql } from "@/storage/db"
import type { SQL } from "@/storage/db"
import { toLogicalPath } from "@opencode-ai/core/util/path"

/**
 * SQL predicate matching a path column against a logical directory value,
 * ignoring Windows `\` vs `/` differences.
 *
 * Use this instead of bare `eq(column, value)` for any DB column that holds a
 * directory string (session.directory, project.worktree, project.sandboxes,
 * channel mapping). Session/project writes normalize to `/` via
 * {@link toLogicalPath}; this predicate remains tolerant so legacy rows that
 * still hold `\` match until a lazy rewrite normalizes them.
 *
 * @example
 *   .where(directorySqlEq(SessionTable.directory, input.directory))
 */
export function directorySqlEq(column: unknown, value: string): SQL {
  const normalized = toLogicalPath(value)
  // char(92) is the backslash; SQLite escapes it via the char() function so
  // the template literal does not need an odd number of backslashes.
  return sql`replace(${column}, char(92), '/') = ${normalized}`
}

export * as DirectorySql from "./directory-sql"