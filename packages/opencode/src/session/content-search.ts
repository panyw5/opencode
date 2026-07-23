import { Effect } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { and, asc, gt } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Database, type TxOrDb } from "@/storage/db"
import { PartTable } from "./session.sql"
import { SessionContentSearchProgressTable } from "./content-search.sql"
import type { MessageV2 } from "./message-v2"
import type { PartID } from "./schema"

const pageSize = 100
const defaultLimit = 30
const maxLimit = 100
const log = Log.create({ service: "session.content-search" })

export type SearchResult = {
  sessionID: string
  messageID: string
  partID: string
  projectID: string
  directory: string
  sessionTitle: string
  snippet: string
  time: number
  role?: string
}

export type SearchResponse = {
  results: SearchResult[]
  nextCursor?: number
  index: IndexStatus
}

export const IndexState = ["disabled", "running", "paused", "complete"] as const
export type IndexState = (typeof IndexState)[number]
export type IndexStatus = {
  enabled: boolean
  state: IndexState
  indexed: number
  total: number
  complete: boolean
  known: boolean
}
type IndexProgress = IndexStatus & { cursor?: PartID; generation: number }
type BackfillPart = {
  id: PartID
  messageID: string
  sessionID: string
  data: (typeof PartTable.$inferSelect)["data"]
}
type ProgressRow = typeof SessionContentSearchProgressTable.$inferSelect

// Treat every whitespace-separated term as a literal FTS phrase. This avoids
// exposing MATCH syntax (operators, column selectors, and quotes) to callers.
function matchQuery(query: string) {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ")
}

function searchableText(part: MessageV2.Part | (typeof PartTable.$inferSelect)["data"]) {
  if (part.type !== "text") return
  const text = part as MessageV2.TextPart
  if (text.synthetic || text.ignored || !text.text.trim()) return
  return text.text
}

function isSearchablePart() {
  return sql`json_extract(${PartTable.data}, '$.type') = 'text'
    AND COALESCE(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
    AND COALESCE(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
    AND trim(COALESCE(json_extract(${PartTable.data}, '$.text'), '')) != ''`
}

function countSearchableParts(db: TxOrDb) {
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(PartTable)
      .where(isSearchablePart())
      .get()?.count ?? 0
  )
}

function countIndexedParts(db: TxOrDb) {
  return (db.all(sql`SELECT count(*) AS count FROM session_content_fts`)[0] as { count: number } | undefined)?.count ?? 0
}

function readProgressRow(db: TxOrDb) {
  return db
    .select()
    .from(SessionContentSearchProgressTable)
    .where(sql`${SessionContentSearchProgressTable.id} = 1`)
    .get()
}

function toStatus(db: TxOrDb, row?: ProgressRow): IndexProgress {
  if (!row || row.enabled !== 1) {
    return { enabled: false, state: "disabled", indexed: 0, total: 0, complete: false, known: false, generation: 0 }
  }

  const state = IndexState.includes(row.state as IndexState) ? (row.state as IndexState) : "disabled"
  const complete = row.complete === 1 || state === "complete"
  return {
    enabled: true,
    state: complete ? "complete" : state,
    // Live counts: the durable table only tracks control plane state (cursor/generation).
    indexed: countIndexedParts(db),
    total: countSearchableParts(db),
    complete,
    known: true,
    generation: row.generation,
    ...(row.cursor ? { cursor: row.cursor as PartID } : {}),
  }
}

export function progress(db: TxOrDb): IndexProgress {
  return toStatus(db, readProgressRow(db))
}

export function upsert(db: TxOrDb, part: MessageV2.Part) {
  db.run(sql`DELETE FROM session_content_fts WHERE part_id = ${part.id}`)
  const row = readProgressRow(db)
  if (!row || row.enabled !== 1) return
  const text = searchableText(part)
  if (!text) return
  db.run(sql`
    INSERT INTO session_content_fts (part_id, message_id, session_id, text)
    VALUES (${part.id}, ${part.messageID}, ${part.sessionID}, ${text})
  `)
}

export function remove(db: TxOrDb, partID: PartID) {
  db.run(sql`DELETE FROM session_content_fts WHERE part_id = ${partID}`)
}

export function enable(db: TxOrDb) {
  db.run(sql`
    INSERT INTO session_content_search_progress (id, enabled, state, indexed, total, complete, generation)
    VALUES (1, 1, 'running', 0, 0, 0, 0)
    ON CONFLICT(id) DO UPDATE SET
      enabled = 1,
      state = CASE WHEN session_content_search_progress.complete = 1 THEN 'complete' ELSE 'running' END
  `)
  return progress(db)
}

export function pause(db: TxOrDb) {
  db.run(sql`UPDATE session_content_search_progress SET state = 'paused' WHERE id = 1 AND enabled = 1 AND complete = 0`)
  return progress(db)
}

export function rebuild(db: TxOrDb) {
  db.run(sql`DELETE FROM session_content_fts`)
  db.run(sql`
    INSERT INTO session_content_search_progress (id, enabled, state, indexed, total, cursor, complete, generation)
    VALUES (1, 1, 'running', 0, 0, NULL, 0, 1)
    ON CONFLICT(id) DO UPDATE SET
      enabled = 1,
      state = 'running',
      indexed = 0,
      total = 0,
      cursor = NULL,
      complete = 0,
      generation = generation + 1
  `)
  return progress(db)
}

export function clear(db: TxOrDb) {
  db.run(sql`DELETE FROM session_content_fts`)
  db.run(sql`
    INSERT INTO session_content_search_progress (id, enabled, state, indexed, total, cursor, complete, generation)
    VALUES (1, 0, 'disabled', 0, 0, NULL, 0, 1)
    ON CONFLICT(id) DO UPDATE SET
      enabled = 0,
      state = 'disabled',
      indexed = 0,
      total = 0,
      cursor = NULL,
      complete = 0,
      generation = generation + 1
  `)
  return progress(db)
}

function active(row: ProgressRow | undefined, generation: number) {
  return !!row && row.enabled === 1 && row.state === "running" && row.complete === 0 && row.generation === generation
}

export function writeBackfillBatch(db: TxOrDb, generation: number, parts: BackfillPart[]) {
  const row = readProgressRow(db)
  if (!active(row, generation)) return progress(db)

  for (const part of parts) {
    upsert(db, {
      ...part.data,
      id: part.id,
      messageID: part.messageID,
      sessionID: part.sessionID,
    } as MessageV2.Part)
  }

  const nextCursor = parts.at(-1)?.id
  if (!nextCursor) return progress(db)

  db.run(sql`
    UPDATE session_content_search_progress
    SET indexed = indexed + ${parts.length}, cursor = ${nextCursor}
    WHERE id = 1 AND enabled = 1 AND state = 'running' AND complete = 0 AND generation = ${generation}
  `)
  return progress(db)
}

function completeBackfill(db: TxOrDb, generation: number) {
  db.run(sql`
    UPDATE session_content_search_progress
    SET state = 'complete', complete = 1
    WHERE id = 1 AND enabled = 1 AND state = 'running' AND complete = 0 AND generation = ${generation}
  `)
  return progress(db)
}

export const backfill = Effect.fn("SessionContentSearch.backfill")(function* () {
  let state = yield* Effect.sync(() => Database.use(progress))
  log.info("session-content-search:backfill-started", {
    indexed: state.indexed,
    total: state.total,
    complete: state.complete,
    cursorPresent: state.cursor !== undefined,
  })
  if (!state.enabled || state.complete || state.state === "paused") {
    log.info("session-content-search:backfill-skipped")
    return
  }
  const generation = state.generation

  try {
    for (;;) {
      state = yield* Effect.sync(() => Database.use(progress))
      if (!state.enabled || state.state !== "running" || state.complete || state.generation !== generation) return

      const cursor = state.cursor
      const parts = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select({
              id: PartTable.id,
              messageID: PartTable.message_id,
              sessionID: PartTable.session_id,
              data: PartTable.data,
            })
            .from(PartTable)
            .where(and(isSearchablePart(), cursor ? gt(PartTable.id, cursor) : undefined))
            .orderBy(asc(PartTable.id))
            .limit(pageSize)
            .all(),
        ),
      )

      if (parts.length === 0) {
        state = yield* Effect.sync(() => Database.transaction((db) => completeBackfill(db, generation)))
        if (!state.complete || state.generation !== generation) return
        log.info("session-content-search:backfill-completed", {
          indexed: state.indexed,
          total: state.total,
          cursorPresent: state.cursor !== undefined,
        })
        return
      }

      state = yield* Effect.sync(() => Database.transaction((db) => writeBackfillBatch(db, generation, parts)))
      if (!state.enabled || state.generation !== generation || state.state !== "running") return
      log.info("session-content-search:backfill-batch-completed", {
        batchSize: parts.length,
        indexed: state.indexed,
        total: state.total,
        cursorPresent: state.cursor !== undefined,
      })
      yield* Effect.sleep("10 millis")
    }
  } catch (error) {
    log.error("session-content-search:backfill-failed", {
      error: error instanceof Error ? error : String(error),
    })
    throw error
  }
})

export const clearSession = (db: TxOrDb, sessionID: string) =>
  db.run(sql`DELETE FROM session_content_fts WHERE session_id = ${sessionID}`)

export function search(input: {
  query: string
  directory?: string
  archived?: boolean
  limit?: number
  cursor?: number
}): SearchResponse {
  const started = Date.now()
  const query = matchQuery(input.query)
  const limit = Math.min(Math.max(input.limit ?? defaultLimit, 1), maxLimit)
  log.info("session-content-search:enter", {
    queryLength: input.query.length,
    hasDirectory: input.directory !== undefined,
    archived: input.archived ?? false,
    limit,
    hasCursor: input.cursor !== undefined,
  })
  try {
    const status = Database.use(progress)
    if (!query || !status.enabled) {
      log.info("session-content-search:return", { resultCount: 0, durationMs: Date.now() - started })
      return { results: [], index: status }
    }

    const ftsStarted = Date.now()
    log.info("session-content-search:fts-start", { queryLength: input.query.length, limit })
    const results = Database.use(
      (db) =>
        db.all(sql<SearchResult>`
        SELECT
          session_content_fts.session_id AS sessionID,
          session_content_fts.message_id AS messageID,
          session_content_fts.part_id AS partID,
          s.project_id AS projectID,
          s.directory AS directory,
          s.title AS sessionTitle,
          snippet(session_content_fts, 3, '', '', '…', 16) AS snippet,
          s.time_updated AS time,
          json_extract(m.data, '$.role') AS role
        FROM session_content_fts
        JOIN session s ON s.id = session_content_fts.session_id
        JOIN message m ON m.id = session_content_fts.message_id
        WHERE session_content_fts MATCH ${query}
          AND (${input.directory ?? null} IS NULL OR s.directory = ${input.directory ?? null})
          AND (${input.archived ? 1 : 0} = 1 OR s.time_archived IS NULL)
          AND (${input.cursor ?? null} IS NULL OR s.time_updated < ${input.cursor ?? null})
        ORDER BY s.time_updated DESC, session_content_fts.rowid DESC
        LIMIT ${limit + 1}
        `) as SearchResult[],
    )
    log.info("session-content-search:fts-complete", { durationMs: Date.now() - ftsStarted, rowCount: results.length })
    const page = results.slice(0, limit)
    log.info("session-content-search:return", { resultCount: page.length, durationMs: Date.now() - started })
    return {
      results: page,
      ...(results.length > limit && page.length > 0 ? { nextCursor: page.at(-1)!.time } : {}),
      index: status,
    }
  } catch (error) {
    log.error("session-content-search:error", {
      durationMs: Date.now() - started,
      error: error instanceof Error ? error : String(error),
    })
    throw error
  }
}

export * as SessionContentSearch from "./content-search"
