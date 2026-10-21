import { expect } from "bun:test"
import { Effect } from "effect"
import { Database, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { Session } from "@/session/session"
import { getContextLocale, setContextLocale } from "@/session/context-locale"
import { clearTaskContextFullInject } from "@/project-task/inject-state"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

it.instance("locale persists independently of inject bookkeeping without replacing other metadata", () =>
  Effect.gen(function* () {
    const session = yield* (yield* Session.Service).create({ title: "Locale isolation" })
    expect(getContextLocale(session.id)).toBe("en")
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({ metadata: { gptProAutoWakePaused: true } })
        .where(eq(SessionTable.id, session.id))
        .run(),
    )
    setContextLocale(session.id, "zh")
    clearTaskContextFullInject(session.id)
    expect(getContextLocale(session.id)).toBe("zh")
    expect(
      Database.use(
        (db) =>
          db.select({ metadata: SessionTable.metadata }).from(SessionTable).where(eq(SessionTable.id, session.id)).get()
            ?.metadata,
      ),
    ).toEqual({
      gptProAutoWakePaused: true,
      contextLocale: "zh",
    })
    setContextLocale(session.id, "ja")
    expect(getContextLocale(session.id)).toBe("ja")
  }),
)
