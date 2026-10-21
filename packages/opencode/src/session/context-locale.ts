import { parseUILocale, type UILocale } from "@opencode-ai/core/locale"
import { Database, eq } from "@/storage/db"
import { SessionTable } from "./session.sql"
import type { SessionID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "session.context-locale" })

export function getContextLocale(sessionID: SessionID): UILocale {
  return Database.use((db) => {
    const row = db
      .select({ metadata: SessionTable.metadata })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
    return parseUILocale(row?.metadata?.contextLocale) ?? "en"
  })
}

export function setContextLocale(sessionID: SessionID, locale: UILocale): void {
  Database.transaction((db) => {
    const row = db
      .select({ metadata: SessionTable.metadata })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
    if (!row || row.metadata?.contextLocale === locale) return
    db.update(SessionTable)
      .set({ metadata: { ...row.metadata, contextLocale: locale } })
      .where(eq(SessionTable.id, sessionID))
      .run()
    log.info("context locale saved", { sessionID, locale })
  })
}
