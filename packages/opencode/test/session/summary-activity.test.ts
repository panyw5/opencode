import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { SessionTable } from "@/session/session.sql"
import { MessageID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Database } from "@/storage/db"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(SessionSummary.defaultLayer, Session.defaultLayer, Storage.defaultLayer))

it.instance("repairing and reading legacy summaries preserves activity and session ordering", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const summary = yield* SessionSummary.Service
    const storage = yield* Storage.Service
    const old = yield* sessions.create({ title: "July conversation" })
    const recent = yield* sessions.create({ title: "October conversation" })
    const july = Date.UTC(2026, 6, 2)
    const october = Date.UTC(2026, 9, 30)
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID: old.id,
      role: "user",
      time: { created: july },
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      summary: { diffs: [{ file: "unowned.txt", before: "", after: "old", additions: 1, deletions: 0 }] },
    })
    Database.use((db) => {
      db.update(SessionTable).set({ time_created: july, time_updated: july }).where(eq(SessionTable.id, old.id)).run()
      db.update(SessionTable)
        .set({ time_created: october, time_updated: october })
        .where(eq(SessionTable.id, recent.id))
        .run()
    })

    const order = () => sessions.list({ roots: true }).pipe(Effect.map((items) => items.map((item) => item.id)))
    expect(yield* order()).toEqual([recent.id, old.id])
    yield* summary.repair(old.id)
    expect((yield* sessions.get(old.id)).time.updated).toBe(july)
    expect((yield* sessions.get(old.id)).summary).toMatchObject({ files: 0, additions: 0, deletions: 0 })
    expect((yield* sessions.messages({ sessionID: old.id }))[0]!.info.summary?.diffs).toEqual([])
    expect(yield* order()).toEqual([recent.id, old.id])

    // Exercise the actual diff read path, including a forced repeat repair.
    yield* storage.remove(["session_diff_version", old.id])
    expect(yield* summary.diff({ sessionID: old.id })).toEqual([])
    expect((yield* sessions.get(old.id)).time.updated).toBe(july)
    yield* sessions.setSummary({ sessionID: old.id, summary: { files: 1, additions: 2, deletions: 0 } })
    expect((yield* sessions.get(old.id)).time.updated).toBe(july)
    expect(yield* order()).toEqual([recent.id, old.id])

    yield* sessions.touch(old.id)
    expect((yield* sessions.get(old.id)).time.updated).toBeGreaterThan(october)
    expect(yield* order()).toEqual([old.id, recent.id])
    yield* sessions.remove(old.id)
    yield* sessions.remove(recent.id)
  }),
)
