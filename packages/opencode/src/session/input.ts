import { Database, and, asc, eq, isNull, isNotNull, sql, type TxOrDb } from "@/storage/db"
import { Effect, Context, Layer } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import {
  SessionInputCursorTable,
  SessionInputTable,
  type SessionInputDelivery,
  type SessionInputID,
  type SessionInputPrompt,
} from "./session.sql"
import { SessionID } from "./schema"
import { SessionTable } from "./session.sql"
import { directorySqlEq } from "@/util/directory-sql"

const log = EffectLogger.create({ service: "session.input" })

export type Info = {
  readonly id: SessionInputID
  readonly sessionID: SessionID
  readonly prompt: SessionInputPrompt
  readonly delivery: SessionInputDelivery
  readonly admittedSeq: number
  readonly promotedSeq: number | null
  readonly timeCreated: number
}

export type AdmitInput = {
  readonly id: SessionInputID
  readonly sessionID: SessionID
  readonly prompt: SessionInputPrompt
  readonly source: string
  readonly delivery?: SessionInputDelivery
}

export type Cursor = {
  readonly sessionID: SessionID
  readonly nextAdmittedSeq: number
  readonly nextPromotedSeq: number
  readonly consumedSeq: number
}

export type Claim = {
  readonly rows: Info[]
  readonly consumedSeq: number
}

export interface Interface {
  readonly admit: (input: AdmitInput) => Effect.Effect<Info>
  readonly pending: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly promotedUnacked: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly pendingSessions: (directory: string) => Effect.Effect<SessionID[]>
  readonly promote: (sessionID: SessionID, limit?: number) => Effect.Effect<Info[]>
  readonly claim: (sessionID: SessionID, inputIDs: readonly SessionInputID[]) => Effect.Effect<Claim>
  readonly cursor: (sessionID: SessionID) => Effect.Effect<Cursor>
  readonly ack: (inputIDs: readonly SessionInputID[]) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionInput") {}

type InputRow = typeof SessionInputTable.$inferSelect

function fromRow(row: InputRow): Info {
  return {
    id: row.id,
    sessionID: row.session_id,
    prompt: row.prompt,
    delivery: row.delivery,
    admittedSeq: row.admitted_seq,
    promotedSeq: row.promoted_seq,
    timeCreated: row.time_created,
  }
}

function ensureCursor(db: TxOrDb, sessionID: SessionID) {
  const existing = db
    .select()
    .from(SessionInputCursorTable)
    .where(eq(SessionInputCursorTable.session_id, sessionID))
    .get()
  const maxima = db
    .select({
      admitted: sql<number>`coalesce(max(${SessionInputTable.admitted_seq}), -1)`,
      promoted: sql<number>`coalesce(max(${SessionInputTable.promoted_seq}), -1)`,
    })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .get()
  if (existing) {
    const nextAdmittedSeq = Math.max(existing.next_admitted_seq, (maxima?.admitted ?? -1) + 1)
    const nextPromotedSeq = Math.max(existing.next_promoted_seq, (maxima?.promoted ?? -1) + 1)
    const stale = db
      .select()
      .from(SessionInputTable)
      .where(
        and(
          eq(SessionInputTable.session_id, sessionID),
          sql`${SessionInputTable.admitted_seq} <= ${existing.consumed_seq}`,
        ),
      )
      .orderBy(asc(SessionInputTable.admitted_seq))
      .all()
    let allocatedAdmittedSeq = nextAdmittedSeq
    for (const row of stale) {
      db.update(SessionInputTable)
        .set({ admitted_seq: allocatedAdmittedSeq })
        .where(eq(SessionInputTable.id, row.id))
        .run()
      allocatedAdmittedSeq++
    }
    if (
      allocatedAdmittedSeq === existing.next_admitted_seq &&
      nextPromotedSeq === existing.next_promoted_seq
    )
      return existing
    const updated = {
      ...existing,
      next_admitted_seq: allocatedAdmittedSeq,
      next_promoted_seq: nextPromotedSeq,
      time_updated: Date.now(),
    }
    db.update(SessionInputCursorTable)
      .set({
        next_admitted_seq: updated.next_admitted_seq,
        next_promoted_seq: updated.next_promoted_seq,
        time_updated: updated.time_updated,
      })
      .where(eq(SessionInputCursorTable.session_id, sessionID))
      .run()
    return updated
  }

  const now = Date.now()
  const row: typeof SessionInputCursorTable.$inferInsert = {
    session_id: sessionID,
    next_admitted_seq: (maxima?.admitted ?? -1) + 1,
    next_promoted_seq: (maxima?.promoted ?? -1) + 1,
    consumed_seq: -1,
    time_created: now,
    time_updated: now,
  }
  db.insert(SessionInputCursorTable).values(row).run()
  return row as typeof SessionInputCursorTable.$inferSelect
}

function fromCursor(row: typeof SessionInputCursorTable.$inferSelect): Cursor {
  return {
    sessionID: row.session_id,
    nextAdmittedSeq: row.next_admitted_seq,
    nextPromotedSeq: row.next_promoted_seq,
    consumedSeq: row.consumed_seq,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const admit = Effect.fn("SessionInput.admit")(function* (input: AdmitInput) {
      const source = input.source.trim()
      if (!source) yield* Effect.die(new Error("SessionInput.admit requires a non-empty source"))
      const delivery = input.delivery ?? "deferred"
      const result = Database.transaction(
        (db) => {
          const existing = db.select().from(SessionInputTable).where(eq(SessionInputTable.id, input.id)).get()
          if (existing) return { row: existing, inserted: false }

          const cursor = ensureCursor(db, input.sessionID)
          const row: typeof SessionInputTable.$inferInsert = {
            id: input.id,
            session_id: input.sessionID,
            prompt: input.prompt,
            delivery,
            admitted_seq: cursor.next_admitted_seq,
            promoted_seq: null,
            time_created: Date.now(),
          }
          db.update(SessionInputCursorTable)
            .set({ next_admitted_seq: cursor.next_admitted_seq + 1, time_updated: Date.now() })
            .where(eq(SessionInputCursorTable.session_id, input.sessionID))
            .run()
          db.insert(SessionInputTable).values(row).run()
          return { row: row as InputRow, inserted: true }
        },
        { behavior: "immediate" },
      )

      const info = fromRow(result.row)
      yield* result.inserted
        ? log.info("inbox admit inserted", {
            sessionID: input.sessionID,
            inputID: input.id,
            source,
            admittedSeq: info.admittedSeq,
          })
        : log.info("inbox admit duplicate", {
            sessionID: info.sessionID,
            inputID: info.id,
            source,
            admittedSeq: info.admittedSeq,
          })
      return info
    })

    const pending = Effect.fn("SessionInput.pending")(function* (sessionID: SessionID) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, sessionID),
              isNull(SessionInputTable.promoted_seq),
              eq(SessionInputTable.delivery, "deferred"),
            ),
          )
          .orderBy(asc(SessionInputTable.admitted_seq))
          .all(),
      )
      const result = rows.map(fromRow)
      yield* log.debug("inbox pending queried", {
        sessionID,
        source: "session-input",
        count: result.length,
      })
      return result
    })

    const promotedUnacked = Effect.fn("SessionInput.promotedUnacked")(function* (sessionID: SessionID) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, sessionID),
              isNotNull(SessionInputTable.promoted_seq),
              eq(SessionInputTable.delivery, "deferred"),
            ),
          )
          .orderBy(asc(SessionInputTable.promoted_seq), asc(SessionInputTable.admitted_seq))
          .all(),
      )
      const result = rows.map(fromRow)
      yield* log.debug("inbox promoted-unacked queried", {
        sessionID,
        source: "session-input",
        count: result.length,
      })
      return result
    })

    const pendingSessions = Effect.fn("SessionInput.pendingSessions")(function* (directory: string) {
      const rows = Database.use((db) =>
        db
          .select({ sessionID: SessionInputTable.session_id })
          .from(SessionInputTable)
          .innerJoin(SessionTable, eq(SessionTable.id, SessionInputTable.session_id))
          .where(and(eq(SessionInputTable.delivery, "deferred"), directorySqlEq(SessionTable.directory, directory)))
          .orderBy(asc(SessionInputTable.session_id), asc(SessionInputTable.admitted_seq))
          .all(),
      )
      const sessions: SessionID[] = []
      const seen = new Set<SessionID>()
      for (const row of rows) {
        if (seen.has(row.sessionID)) continue
        seen.add(row.sessionID)
        sessions.push(row.sessionID)
      }
      yield* log.info("inbox recovery scan", {
        source: "session-input",
        directory,
        sessionCount: sessions.length,
      })
      return sessions
    })

    const promote = Effect.fn("SessionInput.promote")(function* (sessionID: SessionID, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1)
        yield* Effect.die(new Error("SessionInput.promote limit must be positive"))
      const claimed = Database.transaction(
        (db) => {
          const cursor = ensureCursor(db, sessionID)
          const rows = db
            .select()
            .from(SessionInputTable)
            .where(
              and(
                eq(SessionInputTable.session_id, sessionID),
                isNull(SessionInputTable.promoted_seq),
                eq(SessionInputTable.delivery, "deferred"),
              ),
            )
            .orderBy(asc(SessionInputTable.admitted_seq))
            .all()
            .slice(0, limit)
          if (rows.length === 0) return []

          let promotedSeq = cursor.next_promoted_seq
          const result: InputRow[] = []
          for (const row of rows) {
            db.update(SessionInputTable)
              .set({ promoted_seq: promotedSeq })
              .where(eq(SessionInputTable.id, row.id))
              .run()
            result.push({ ...row, promoted_seq: promotedSeq })
            promotedSeq++
          }
          db.update(SessionInputCursorTable)
            .set({ next_promoted_seq: promotedSeq, time_updated: Date.now() })
            .where(eq(SessionInputCursorTable.session_id, sessionID))
            .run()
          return result
        },
        { behavior: "immediate" },
      )

      for (const row of claimed) {
        yield* log.info("inbox promotion claimed", {
          sessionID,
          inputID: row.id,
          source: "session-input",
          admittedSeq: row.admitted_seq,
          promotedSeq: row.promoted_seq,
        })
      }
      return claimed.map(fromRow)
    })

    const cursor = Effect.fn("SessionInput.cursor")(function* (sessionID: SessionID) {
      const row = Database.transaction((db) => ensureCursor(db, sessionID), { behavior: "immediate" })
      return fromCursor(row)
    })

    const claim = Effect.fn("SessionInput.claim")(function* (
      sessionID: SessionID,
      inputIDs: readonly SessionInputID[],
    ) {
      const ids = new Set(inputIDs)
      const result = Database.transaction(
        (db) => {
          const cursor = ensureCursor(db, sessionID)
          if (ids.size === 0) return { rows: [] as InputRow[], consumedSeq: cursor.consumed_seq }
          const rows = db
            .select()
            .from(SessionInputTable)
            .where(
              and(
                eq(SessionInputTable.session_id, sessionID),
                isNotNull(SessionInputTable.promoted_seq),
                eq(SessionInputTable.delivery, "deferred"),
                sql`${SessionInputTable.admitted_seq} > ${cursor.consumed_seq}`,
              ),
            )
            .orderBy(asc(SessionInputTable.admitted_seq))
            .all()
          const prefix: InputRow[] = []
          for (const row of rows) {
            if (!ids.has(row.id)) break
            prefix.push(row)
          }
          if (prefix.length === 0) return { rows: prefix, consumedSeq: cursor.consumed_seq }
          const consumedSeq = prefix[prefix.length - 1]!.admitted_seq
          db.update(SessionInputCursorTable)
            .set({ consumed_seq: consumedSeq, time_updated: Date.now() })
            .where(eq(SessionInputCursorTable.session_id, sessionID))
            .run()
          for (const row of prefix) db.delete(SessionInputTable).where(eq(SessionInputTable.id, row.id)).run()
          return { rows: prefix, consumedSeq }
        },
        { behavior: "immediate" },
      )
      yield* log.info("inbox model input claimed", {
        sessionID,
        source: "session-input",
        count: result.rows.length,
        consumedSeq: result.consumedSeq,
      })
      return { rows: result.rows.map(fromRow), consumedSeq: result.consumedSeq }
    })

    const ack = Effect.fn("SessionInput.ack")(function* (inputIDs: readonly SessionInputID[]) {
      const ids = [...new Set(inputIDs)]
      if (ids.length === 0) return
      const result = Database.transaction(
        (db) => {
          let deleted = 0
          for (const id of ids) {
            const existing = db
              .select({ id: SessionInputTable.id })
              .from(SessionInputTable)
              .where(eq(SessionInputTable.id, id))
              .get()
            if (!existing) continue
            db.delete(SessionInputTable).where(eq(SessionInputTable.id, id)).run()
            deleted++
          }
          return deleted
        },
        { behavior: "immediate" },
      )
      yield* log.info("inbox ack", {
        source: "session-input",
        inputIDs: ids,
        deleted: result,
        idempotent: result !== ids.length,
      })
    })

    return Service.of({ admit, pending, promotedUnacked, pendingSessions, promote, claim, cursor, ack })
  }),
)

export const defaultLayer = layer

export * as SessionInput from "./input"
