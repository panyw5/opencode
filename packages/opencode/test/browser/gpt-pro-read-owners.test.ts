import { expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { gptProReadOwners } from "@/browser/gpt-pro-read-owners"
import { Database, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const it = testEffect(Session.defaultLayer)
it.instance("read handoff authorizes descendants, not siblings, ancestors or other directories", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const { directory } = yield* TestInstance
    const parent = yield* sessions.create({ title: "parent" })
    const child = yield* sessions.create({ parentID: parent.id, title: "child" })
    const grandchild = yield* sessions.create({ parentID: child.id, title: "grandchild" })
    const unrelated = yield* sessions.create({ title: "unrelated" })
    const owner = (id: string) => `${directory}\n${id}`
    expect(gptProReadOwners(owner(parent.id))).toEqual([owner(parent.id), owner(child.id), owner(grandchild.id)])
    expect(gptProReadOwners(owner(child.id))).not.toContain(owner(parent.id))
    expect(gptProReadOwners(owner(parent.id))).not.toContain(owner(unrelated.id))
    yield* Effect.sync(() =>
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ directory: `${directory}/other` })
          .where(eq(SessionTable.id, child.id))
          .run(),
      ),
    )
    expect(gptProReadOwners(owner(parent.id))).toEqual([owner(parent.id)])
  }),
)
