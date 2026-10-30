import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { and, Database, eq, inArray } from "@/storage/db"
import * as Log from "@opencode-ai/core/util/log"
import { CodeModeCatalog } from "./code-mode-catalog"
import { CodeModeInstructions } from "./code-mode-instructions"
import { CodeModeInstructionTable } from "./code-mode-state.sql"
import { MessageTable } from "./session.sql"
import { MessageID, PartID, type SessionID } from "./schema"
import { MessageV2 } from "./message-v2"

const log = Log.create({ service: "session.code-mode-state" })
const empty: CodeModeCatalog.Summary = { total: 0, shown: 0, namespaces: [] }
const decode = Schema.decodeUnknownSync(CodeModeCatalog.Summary)
type Snapshot = typeof CodeModeInstructionTable.$inferSelect

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
      .join(",")}}`
  return JSON.stringify(value)
}

export const hash = (value: CodeModeCatalog.Summary) => createHash("sha256").update(canonical(value)).digest("hex")

export const prepare = Effect.fn("CodeModeState.prepare")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  user: MessageV2.User
  messages: MessageV2.WithParts[]
  catalog?: CodeModeCatalog.Summary
}) {
  // A compaction starts a new instruction epoch. Retained tail messages may be
  // displayed after its summary, but their old snapshots must not re-enter it.
  const chronological = input.messages.toSorted((a, b) => MessageV2.compareMessageInfo(a.info, b.info))
  const checkpoint = chronological.findLast(
    (message) =>
      message.info.role === "assistant" && message.info.summary && message.info.finish && !message.info.error,
  )?.info
  const ids = [
    ...new Set([
      ...chronological
        .filter((message) => !checkpoint || MessageV2.compareMessageInfo(message.info, checkpoint) > 0)
        .map((message) => message.info.id),
      input.messageID,
    ]),
  ]
  const current = input.catalog ?? empty
  const currentHash = hash(current)
  log.info("catalog observation started", {
    sessionID: input.sessionID,
    messageID: input.messageID,
    checkpoint: checkpoint?.id,
    total: current.total,
    shown: current.shown,
  })
  const snapshots = Database.transaction((db) => {
    const rows: Snapshot[] = []
    for (let offset = 0; offset < ids.length; offset += 400)
      rows.push(
        ...db
          .select()
          .from(CodeModeInstructionTable)
          .where(
            and(
              eq(CodeModeInstructionTable.session_id, input.sessionID),
              inArray(CodeModeInstructionTable.message_id, ids.slice(offset, offset + 400)),
            ),
          )
          .all(),
      )
    const byID = new Map(rows.map((row) => [row.message_id, row]))
    const ordered = ids.flatMap((id) => (byID.has(id) ? [byID.get(id)!] : []))
    for (const row of ordered) {
      row.snapshot = decode(row.snapshot)
      if (hash(row.snapshot) !== row.hash) throw new Error(`Code Mode snapshot hash mismatch: ${row.message_id}`)
    }
    const existing = byID.get(input.messageID)
    if (existing) {
      if (existing.hash !== currentHash) throw new Error(`Code Mode request snapshot is immutable: ${input.messageID}`)
      log.info("request snapshot replayed", {
        sessionID: input.sessionID,
        messageID: input.messageID,
        hash: currentHash,
      })
      return ordered
    }
    const previous = ordered.at(-1)
    if (previous?.hash === currentHash || (!previous && current.total === 0)) {
      log.info("catalog unchanged", { sessionID: input.sessionID, hash: currentHash, snapshots: ordered.length })
      return ordered
    }
    const message = db
      .select({ data: MessageTable.data })
      .from(MessageTable)
      .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
      .get()
    if (message?.data.role !== "assistant") throw new Error(`Code Mode request anchor not found: ${input.messageID}`)
    const row: Snapshot = {
      session_id: input.sessionID,
      message_id: input.messageID,
      hash: currentHash,
      snapshot: current,
      kind: previous ? "update" : "initial",
      text: previous ? CodeModeInstructions.update(previous.snapshot, current) : CodeModeInstructions.render(current),
    }
    db.insert(CodeModeInstructionTable).values(row).run()
    log.info("catalog snapshot committed", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      kind: row.kind,
      hash: currentHash,
      chars: row.text.length,
    })
    return [...ordered, row]
  })
  const baseline = snapshots[0]
  if (!baseline) return { system: undefined, messages: input.messages }
  if (baseline.kind !== "initial")
    log.warn("recovering baseline from visible snapshot", {
      sessionID: input.sessionID,
      messageID: baseline.message_id,
    })
  const updates = new Map(snapshots.slice(1).map((row) => [row.message_id, row]))
  const notification = (row: Snapshot): MessageV2.WithParts => ({
    info: { ...input.user, id: MessageID.make(`msg_codemode_${row.message_id.slice(4)}`), system: undefined },
    parts: [
      {
        type: "text",
        id: PartID.make(`prt_codemode_${row.message_id.slice(4)}`),
        sessionID: input.sessionID,
        messageID: MessageID.make(`msg_codemode_${row.message_id.slice(4)}`),
        synthetic: true,
        text: `<system-reminder>\n${row.text}\n</system-reminder>`,
      },
    ],
  })
  const messages = input.messages.flatMap((message) => {
    const update = updates.get(message.info.id)
    updates.delete(message.info.id)
    return update ? [notification(update), message] : [message]
  })
  // The current assistant anchor has not joined the history snapshot yet.
  for (const update of updates.values()) messages.push(notification(update))
  log.info("catalog context assembled", {
    sessionID: input.sessionID,
    baseline: baseline.message_id,
    updates: snapshots.length - 1,
  })
  return {
    system: baseline.kind === "initial" ? baseline.text : CodeModeInstructions.render(baseline.snapshot),
    messages,
  }
})

export function copy(source: SessionID, target: SessionID, ids: ReadonlyMap<string, MessageID>) {
  Database.transaction((db) => {
    const rows = db.select().from(CodeModeInstructionTable).where(eq(CodeModeInstructionTable.session_id, source)).all()
    let copied = 0
    for (const row of rows) {
      const messageID = ids.get(row.message_id)
      if (!messageID) continue
      db.insert(CodeModeInstructionTable)
        .values({ ...row, session_id: target, message_id: messageID })
        .run()
      copied++
    }
    log.info("fork snapshots copied", { source, target, copied })
  })
}

export * as CodeModeState from "./code-mode-state"
