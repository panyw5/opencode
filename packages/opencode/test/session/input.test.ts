import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { SessionInput } from "@/session/input"
import { SessionID } from "@/session/schema"
import { SessionInputTable, SessionTable } from "@/session/session.sql"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { Database } from "@/storage/db"
import { testEffect } from "../lib/effect"
import { EventV2 } from "@opencode-ai/core/event"

const it = testEffect(SessionInput.defaultLayer)

const seedSession = Effect.fn("SessionInputTest.seedSession")(function* (directory = "/tmp") {
  const projectID = ProjectID.ascending()
  const sessionID = SessionID.descending()
  const now = Date.now()
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({
        id: projectID,
        worktree: "/tmp",
        time_created: now,
        time_updated: now,
        sandboxes: [],
      })
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        slug: "input-test",
        directory,
        title: "Input test",
        version: "test",
        time_created: now,
        time_updated: now,
      })
      .run()
  })
  return sessionID
})

function admit(sessionID: SessionID, text: string) {
  return {
    id: EventV2.ID.create(),
    sessionID,
    prompt: { text },
    source: "test",
  }
}

describe("SessionInput", () => {
  it.instance("assigns ordered sequences and deduplicates stable IDs", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      const first = admit(sessionID, "first")
      const a = yield* service.admit(first)
      const duplicate = yield* service.admit({ ...first, prompt: { text: "ignored duplicate" } })
      const b = yield* service.admit(admit(sessionID, "second"))

      expect(a.admittedSeq).toBe(0)
      expect(duplicate.id).toBe(a.id)
      expect(duplicate.prompt.text).toBe("first")
      expect(b.admittedSeq).toBe(1)
      expect((yield* service.pending(sessionID)).map((item) => item.prompt.text)).toEqual(["first", "second"])
      expect(yield* service.pendingSessions("/tmp")).toContain(sessionID)
    }),
  )

  it.instance("scopes recovery scans to the owning session directory", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionA = yield* seedSession("/tmp/project-a")
      const sessionB = yield* seedSession("/tmp/project-b")
      yield* service.admit(admit(sessionA, "for a"))
      yield* service.admit(admit(sessionB, "for b"))

      expect(yield* service.pendingSessions("/tmp/project-a")).toEqual([sessionA])
      expect(yield* service.pendingSessions("/tmp/project-b")).toEqual([sessionB])
      expect(yield* service.pendingSessions("/tmp/project-c")).toEqual([])
    }),
  )

  it.instance("claims a batch atomically and concurrent claimers do not overlap", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      yield* service.admit(admit(sessionID, "first"))
      yield* service.admit(admit(sessionID, "second"))
      yield* service.admit(admit(sessionID, "third"))

      const [first, second] = yield* Effect.all(
        [service.promote(sessionID, 2), service.promote(sessionID, 2)].map((effect) => effect.pipe(Effect.forkChild)),
      ).pipe(Effect.flatMap((fibers) => Effect.all(fibers.map(Fiber.join))))
      const claimed = [...first, ...second].sort((a, b) => a.admittedSeq - b.admittedSeq)

      expect(claimed.map((item) => item.prompt.text)).toEqual(["first", "second", "third"])
      expect(claimed.map((item) => item.promotedSeq)).toEqual([0, 1, 2])
      expect(yield* service.pending(sessionID)).toEqual([])
    }),
  )

  it.instance("replays promoted rows until they are acknowledged and makes ack idempotent", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      const input = admit(sessionID, "replay me")
      yield* service.admit(input)
      const [claimed] = yield* service.promote(sessionID)

      expect(claimed).toBeDefined()
      expect((yield* service.promotedUnacked(sessionID)).map((item) => item.id)).toEqual([input.id])
      expect(yield* service.pendingSessions("/tmp")).toContain(sessionID)

      yield* service.ack([input.id])
      yield* service.ack([input.id])

      expect(yield* service.promotedUnacked(sessionID)).toEqual([])
      expect(yield* service.pendingSessions("/tmp")).not.toContain(sessionID)
    }),
  )

  it.instance("keeps admission sequences monotonic after acknowledged rows are deleted", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      const first = yield* service.admit(admit(sessionID, "first"))
      yield* service.ack([first.id])
      const second = yield* service.admit(admit(sessionID, "second"))
      const cursor = yield* service.cursor(sessionID)

      expect(second.admittedSeq).toBe(1)
      expect(cursor.nextAdmittedSeq).toBe(2)
      expect(cursor.consumedSeq).toBe(-1)
    }),
  )

  it.instance("reconciles the allocator after an older client writes without the cursor", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      yield* service.admit(admit(sessionID, "new-client-first"))
      Database.use((db) =>
        db
          .insert(SessionInputTable)
          .values({
            id: "evt_legacy_writer",
            session_id: sessionID,
            prompt: { text: "legacy writer" },
            delivery: "deferred",
            admitted_seq: 1,
            promoted_seq: null,
            time_created: Date.now(),
          })
          .run(),
      )

      const next = yield* service.admit(admit(sessionID, "new-client-after-legacy"))
      expect(next.admittedSeq).toBe(2)
      expect((yield* service.cursor(sessionID)).nextAdmittedSeq).toBe(3)
    }),
  )

  it.instance("renumbers an older client row written below the consumed boundary", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      const first = yield* service.admit(admit(sessionID, "first"))
      yield* service.promote(sessionID)
      yield* service.claim(sessionID, [first.id])
      Database.use((db) =>
        db
          .insert(SessionInputTable)
          .values({
            id: "evt_legacy_reused_sequence",
            session_id: sessionID,
            prompt: { text: "legacy reused sequence" },
            delivery: "deferred",
            admitted_seq: 0,
            promoted_seq: null,
            time_created: Date.now(),
          })
          .run(),
      )

      const [promoted] = yield* service.promote(sessionID)
      expect(promoted?.admittedSeq).toBe(1)
      const claimed = yield* service.claim(sessionID, ["evt_legacy_reused_sequence"])
      expect(claimed.rows.map((row) => row.admittedSeq)).toEqual([1])
      expect(claimed.consumedSeq).toBe(1)
      expect(yield* service.promotedUnacked(sessionID)).toEqual([])
    }),
  )

  it.instance("allocates unique ordered sequences for concurrent admissions", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      const inputs = Array.from({ length: 20 }, (_, index) => admit(sessionID, `input-${index}`))
      const rows = yield* Effect.all(
        inputs.map((input) => service.admit(input)),
        { concurrency: "unbounded" },
      )
      const sequences = rows.map((row) => row.admittedSeq).sort((a, b) => a - b)

      expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index))
      expect(new Set(sequences).size).toBe(20)
      expect((yield* service.cursor(sessionID)).nextAdmittedSeq).toBe(20)
    }),
  )

  it.instance("advances the consumed boundary only across a claimed contiguous prefix", () =>
    Effect.gen(function* () {
      const service = yield* SessionInput.Service
      const sessionID = yield* seedSession()
      const first = yield* service.admit(admit(sessionID, "first"))
      const second = yield* service.admit(admit(sessionID, "second"))
      const third = yield* service.admit(admit(sessionID, "third"))
      yield* service.promote(sessionID)

      const skipped = yield* service.claim(sessionID, [second.id])
      expect(skipped.rows).toEqual([])
      expect(skipped.consumedSeq).toBe(-1)

      const prefix = yield* service.claim(sessionID, [first.id, second.id])
      expect(prefix.rows.map((row) => row.id)).toEqual([first.id, second.id])
      expect(prefix.consumedSeq).toBe(1)
      expect((yield* service.promotedUnacked(sessionID)).map((row) => row.id)).toEqual([third.id])

      const rest = yield* service.claim(sessionID, [third.id])
      expect(rest.rows.map((row) => row.id)).toEqual([third.id])
      expect(rest.consumedSeq).toBe(2)
      expect((yield* service.cursor(sessionID)).consumedSeq).toBe(2)
    }),
  )
})
