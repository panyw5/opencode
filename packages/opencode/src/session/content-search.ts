import { Effect } from "effect"
import { asc, gt } from "drizzle-orm"
import { sql } from "drizzle-orm"
import { Database, type TxOrDb } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import type { MessageV2 } from "./message-v2"
import type { PartID } from "./schema"

const pageSize = 100
const defaultLimit = 30
const maxLimit = 100

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
  index: { indexed: number; total: number; complete: boolean }
}

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

export function upsert(db: TxOrDb, part: MessageV2.Part) {
  db.run(sql`DELETE FROM session_content_fts WHERE part_id = ${part.id}`)
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

export const backfill = Effect.fn("SessionContentSearch.backfill")(function* () {
  for (let cursor: PartID | undefined; ; ) {
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
          .where(cursor ? gt(PartTable.id, cursor) : undefined)
          .orderBy(asc(PartTable.id))
          .limit(pageSize)
          .all(),
      ),
    )
    if (parts.length === 0) return

    yield* Effect.sync(() =>
      Database.transaction((db) => {
        for (const part of parts) {
          upsert(db, {
            ...part.data,
            id: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          } as MessageV2.Part)
        }
      }),
    )
    cursor = parts.at(-1)?.id
    yield* Effect.sleep("10 millis")
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
  const query = matchQuery(input.query)
  const limit = Math.min(Math.max(input.limit ?? defaultLimit, 1), maxLimit)
  const status = Database.use((db) => {
    const indexed = db.select({ count: sql<number>`count(*)` }).from(sql`session_content_fts`).get()?.count ?? 0
    const total =
      db
        .select({ count: sql<number>`count(*)` })
        .from(PartTable)
        .where(sql`json_extract(${PartTable.data}, '$.type') = 'text'
          AND COALESCE(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0
          AND COALESCE(json_extract(${PartTable.data}, '$.ignored'), 0) = 0
          AND trim(COALESCE(json_extract(${PartTable.data}, '$.text'), '')) != ''`)
        .get()?.count ?? 0
    return { indexed, total, complete: indexed >= total }
  })
  if (!query) return { results: [], index: status }

  const results = Database.use((db) =>
    db
      .all(sql<SearchResult>`
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
  const page = results.slice(0, limit)
  return {
    results: page,
    ...(results.length > limit && page.length > 0 ? { nextCursor: page.at(-1)!.time } : {}),
    index: status,
  }
}

export * as SessionContentSearch from "./content-search"
