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

const seedSession = Effect.fn("SessionInputTest.seedSession")(function* () {
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
        directory: "/tmp",
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
      expect(yield* service.pendingSessions()).toContain(sessionID)
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
      expect(yield* service.pendingSessions()).toContain(sessionID)

      yield* service.ack([input.id])
      yield* service.ack([input.id])

      expect(yield* service.promotedUnacked(sessionID)).toEqual([])
      expect(yield* service.pendingSessions()).not.toContain(sessionID)
    }),
  )
})
