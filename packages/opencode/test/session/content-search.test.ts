import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@/storage/db"
import { Project } from "@/project/project"
import { SessionContentSearch } from "@/session/content-search"
import { MessageTable, PartTable } from "@/session/session.sql"
import { Session } from "@/session/session"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { sql } from "drizzle-orm"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Project.defaultLayer, CrossSpawnSpawner.defaultLayer))

function insertTextPart(input: { sessionID: string; messageID: string; partID: string; text: string }) {
  Database.use((db) => {
    db.insert(MessageTable)
      .values({
        id: input.messageID as (typeof MessageTable.$inferInsert)["id"],
        session_id: input.sessionID as (typeof MessageTable.$inferInsert)["session_id"],
        time_created: Date.now(),
        data: { role: "user" },
      })
      .run()
    db.insert(PartTable)
      .values({
        id: input.partID as (typeof PartTable.$inferInsert)["id"],
        message_id: input.messageID as (typeof PartTable.$inferInsert)["message_id"],
        session_id: input.sessionID as (typeof PartTable.$inferInsert)["session_id"],
        time_created: Date.now(),
        data: { type: "text", text: input.text },
      })
      .run()
  })
}

describe("session content search index management", () => {
  it.instance(
    "is disabled by default and only indexes live text after enablement",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const session = yield* Session.use.create({ title: "content search progress" })
        insertTextPart({
          sessionID: session.id,
          messageID: "msg_progress_1",
          partID: "part_progress_1",
          text: "first text",
        })
        insertTextPart({
          sessionID: session.id,
          messageID: "msg_progress_2",
          partID: "part_progress_2",
          text: "second text",
        })

        expect(Database.use((db) => SessionContentSearch.progress(db))).toMatchObject({
          enabled: false,
          state: "disabled",
          known: false,
        })
        SessionContentSearch.upsert(Database.use((db) => db), {
          id: "part_progress_1" as never,
          messageID: "msg_progress_1" as never,
          sessionID: session.id,
          type: "text",
          text: "first text",
        })
        expect(Database.use((db) => db.all(sql`SELECT * FROM session_content_fts`))).toHaveLength(0)
        expect(SessionContentSearch.search({ query: "first" }).results).toEqual([])

        expect(Database.transaction((db) => SessionContentSearch.enable(db))).toMatchObject({
          enabled: true,
          state: "running",
          indexed: 0,
          total: 2,
        })
        yield* SessionContentSearch.backfill()
        expect(Database.use((db) => SessionContentSearch.progress(db))).toMatchObject({
          indexed: 2,
          total: 2,
          complete: true,
          known: true,
        })

        SessionContentSearch.upsert(Database.use((db) => db), {
          id: "part_live" as never,
          messageID: "msg_live" as never,
          sessionID: session.id,
          type: "text",
          text: "live text",
        })
        expect(Database.use((db) => SessionContentSearch.progress(db))).toMatchObject({
          enabled: true,
          complete: true,
          indexed: 3,
          total: 2,
        })
      }),
    { git: true },
  )

  it.instance(
    "pauses, resumes, rebuilds, and clears the persistent index",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const session = yield* Session.use.create({ title: "control plane" })
        insertTextPart({
          sessionID: session.id,
          messageID: "msg_control_1",
          partID: "part_control_1",
          text: "alpha",
        })
        insertTextPart({
          sessionID: session.id,
          messageID: "msg_control_2",
          partID: "part_control_2",
          text: "beta",
        })

        Database.transaction((db) => SessionContentSearch.rebuild(db))
        expect(Database.use((db) => SessionContentSearch.pause(db))).toMatchObject({ enabled: true, state: "paused" })
        yield* SessionContentSearch.backfill()
        expect(Database.use((db) => SessionContentSearch.progress(db))).toMatchObject({
          state: "paused",
          complete: false,
          indexed: 0,
        })

        Database.transaction((db) => SessionContentSearch.enable(db))
        yield* SessionContentSearch.backfill()
        const ready = Database.use((db) => SessionContentSearch.progress(db))
        expect(ready).toMatchObject({
          enabled: true,
          complete: true,
          state: "complete",
          known: true,
        })
        expect(ready.total).toBeGreaterThan(0)
        expect(ready.indexed).toBe(ready.total)
        const rebuilt = Database.use((db) => SessionContentSearch.rebuild(db))
        expect(rebuilt).toMatchObject({
          enabled: true,
          state: "running",
          indexed: 0,
        })
        expect(rebuilt.total).toBe(ready.total)
        expect(Database.use((db) => SessionContentSearch.clear(db))).toMatchObject({
          enabled: false,
          state: "disabled",
          known: false,
        })
        const stale = Database.use((db) =>
          db
            .select({ id: PartTable.id, messageID: PartTable.message_id, sessionID: PartTable.session_id })
            .from(PartTable)
            .get(),
        )
        if (!stale) throw new Error("expected a part to verify the disabled index search gate")
        Database.use((db) => {
          db.run(sql`
            INSERT INTO session_content_fts (part_id, message_id, session_id, text)
            VALUES (${stale.id}, ${stale.messageID}, ${stale.sessionID}, 'stale')
          `)
        })
        expect(SessionContentSearch.search({ query: "stale" }).results).toEqual([])
      }),
    { git: true },
  )

  it.instance(
    "rejects batches from a generation replaced by rebuild or clear",
    () =>
      Effect.gen(function* () {
        yield* TestInstance
        const session = yield* Session.use.create({ title: "generation safety" })
        insertTextPart({
          sessionID: session.id,
          messageID: "msg_generation",
          partID: "part_generation",
          text: "generation",
        })
        Database.transaction((db) => SessionContentSearch.enable(db))
        const firstGeneration = Database.use((db) => SessionContentSearch.progress(db).generation)
        const parts = Database.use((db) =>
          db
            .select({
              id: PartTable.id,
              messageID: PartTable.message_id,
              sessionID: PartTable.session_id,
              data: PartTable.data,
            })
            .from(PartTable)
            .all(),
        )

        Database.transaction((db) => SessionContentSearch.rebuild(db))
        Database.transaction((db) => SessionContentSearch.writeBackfillBatch(db, firstGeneration, parts))
        expect(Database.use((db) => db.all(sql`SELECT * FROM session_content_fts`))).toHaveLength(0)

        const rebuildGeneration = Database.use((db) => SessionContentSearch.progress(db).generation)
        Database.transaction((db) => SessionContentSearch.clear(db))
        Database.transaction((db) => SessionContentSearch.writeBackfillBatch(db, rebuildGeneration, parts))
        expect(Database.use((db) => db.all(sql`SELECT * FROM session_content_fts`))).toHaveLength(0)
        expect(Database.use((db) => SessionContentSearch.progress(db))).toMatchObject({ enabled: false, known: false })
      }),
    { git: true },
  )
})
