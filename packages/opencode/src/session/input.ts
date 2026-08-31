import { Database, and, asc, eq, isNull, isNotNull, sql, type TxOrDb } from "@/storage/db"
import { Effect, Context, Layer } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"
import {
  SessionInputTable,
  type SessionInputDelivery,
  type SessionInputID,
  type SessionInputPrompt,
} from "./session.sql"
import { SessionID } from "./schema"

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

export interface Interface {
  readonly admit: (input: AdmitInput) => Effect.Effect<Info>
  readonly pending: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly promotedUnacked: (sessionID: SessionID) => Effect.Effect<Info[]>
  readonly pendingSessions: () => Effect.Effect<SessionID[]>
  readonly promote: (sessionID: SessionID, limit?: number) => Effect.Effect<Info[]>
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

function nextSequence(db: TxOrDb, sessionID: SessionID, column: "admitted_seq" | "promoted_seq") {
  const result = db
    .select({
      value: sql<number>`coalesce(max(${column === "admitted_seq" ? SessionInputTable.admitted_seq : SessionInputTable.promoted_seq}), -1)`,
    })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, sessionID))
    .get()
  return (result?.value ?? -1) + 1
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

          const row: typeof SessionInputTable.$inferInsert = {
            id: input.id,
            session_id: input.sessionID,
            prompt: input.prompt,
            delivery,
            admitted_seq: nextSequence(db, input.sessionID, "admitted_seq"),
            promoted_seq: null,
            time_created: Date.now(),
          }
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

    const pendingSessions = Effect.fn("SessionInput.pendingSessions")(function* () {
      const rows = Database.use((db) =>
        db
          .select({ sessionID: SessionInputTable.session_id })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.delivery, "deferred"))
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
        sessionCount: sessions.length,
      })
      return sessions
    })

    const promote = Effect.fn("SessionInput.promote")(function* (sessionID: SessionID, limit = 100) {
      if (!Number.isInteger(limit) || limit < 1)
        yield* Effect.die(new Error("SessionInput.promote limit must be positive"))
      const claimed = Database.transaction(
        (db) => {
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

          let promotedSeq = nextSequence(db, sessionID, "promoted_seq")
          const result: InputRow[] = []
          for (const row of rows) {
            db.update(SessionInputTable)
              .set({ promoted_seq: promotedSeq })
              .where(eq(SessionInputTable.id, row.id))
              .run()
            result.push({ ...row, promoted_seq: promotedSeq })
            promotedSeq++
          }
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

    return Service.of({ admit, pending, promotedUnacked, pendingSessions, promote, ack })
  }),
)

export const defaultLayer = layer

export * as SessionInput from "./input"
