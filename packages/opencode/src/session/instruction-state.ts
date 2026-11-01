import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Database, eq } from "@/storage/db"
import * as Log from "@opencode-ai/core/util/log"
import { InstructionSnapshotTable } from "./instruction-state.sql"
import { InstructionSource } from "./instruction-source"
import { MessageTable } from "./session.sql"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, type SessionID } from "./schema"

const log = Log.create({ service: "session.instruction-state" })
type Snapshot = typeof InstructionSnapshotTable.$inferSelect
export class InitializationBlocked extends Schema.TaggedErrorClass<InitializationBlocked>()(
  "InstructionInitializationBlocked",
  { sources: Schema.Array(Schema.String) },
) {
  override get message() {
    return `Instructions are temporarily unavailable: ${this.sources.join(", ")}. No primary model request was sent; retry after the sources recover.`
  }
}
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
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")

export const prepare = Effect.fn("InstructionState.prepare")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  user: MessageV2.User
  messages: MessageV2.WithParts[]
  sources: InstructionSource.Source[]
}) {
  if (new Set(input.sources.map((source) => source.key)).size !== input.sources.length)
    throw new Error("Duplicate instruction source")
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
  const loaded = Database.use((db) =>
    db
      .select({ row: InstructionSnapshotTable, info: MessageTable.data })
      .from(InstructionSnapshotTable)
      .innerJoin(MessageTable, eq(MessageTable.id, InstructionSnapshotTable.message_id))
      .where(eq(InstructionSnapshotTable.session_id, input.sessionID))
      .all(),
  ).toSorted((a, b) =>
    MessageV2.compareMessageInfo({ ...a.info, id: a.row.message_id }, { ...b.info, id: b.row.message_id }),
  )
  const observed = yield* Effect.forEach(
    input.sources,
    (source) =>
      Effect.gen(function* () {
        const records = loaded.filter((item) => item.row.source === source.key)
        for (const item of records)
          if (hash(item.row.snapshot) !== item.row.hash)
            throw new Error(`Instruction snapshot hash mismatch: ${source.key}/${item.row.message_id}`)
        const byID = new Map(records.map((item) => [item.row.message_id, item.row]))
        const active = ids.flatMap((id) => (byID.has(id) ? [byID.get(id)!] : []))
        const previous = active.at(-1) ?? records.at(-1)?.row
        log.info("source observation started", {
          sessionID: input.sessionID,
          source: source.key,
          checkpoint: checkpoint?.id,
          previous: previous?.hash,
        })
        const result = yield* source.read(previous?.snapshot).pipe(
          Effect.catchCause((cause) => {
            log.warn("source read unavailable", {
              sessionID: input.sessionID,
              source: source.key,
              cause: String(cause),
            })
            return Effect.succeed(InstructionSource.unavailable)
          }),
        )
        if (result === InstructionSource.unavailable && !previous) return { source, blocked: true as const, active }
        const value = result === InstructionSource.unavailable ? source.keep(previous!.snapshot) : source.decode(result)
        if (result === InstructionSource.unavailable)
          log.warn("retaining last known source", {
            sessionID: input.sessionID,
            source: source.key,
            hash: previous!.hash,
          })
        return { source, blocked: false as const, active, value, hash: hash(value) }
      }),
    { concurrency: "unbounded" },
  )
  const blocked = observed.filter((item) => item.blocked).map((item) => item.source.key)
  if (blocked.length) {
    log.warn("instruction initialization blocked", { sessionID: input.sessionID, sources: blocked })
    return yield* new InitializationBlocked({ sources: blocked })
  }
  const states = Database.transaction((db) => {
    const anchor = db.select().from(MessageTable).where(eq(MessageTable.id, input.messageID)).get()
    if (anchor?.session_id !== input.sessionID || anchor.data.role !== "assistant")
      throw new Error(`Instruction request anchor missing: ${input.messageID}`)
    return observed.map((item) => {
      if (item.blocked) throw new Error("Blocked instruction source")
      const existing = item.active.find((row) => row.message_id === input.messageID)
      if (existing && existing.hash !== item.hash)
        throw new Error(`Instruction request snapshot is immutable: ${item.source.key}/${input.messageID}`)
      if (existing || item.active.at(-1)?.hash === item.hash) {
        log.info("source unchanged", { sessionID: input.sessionID, source: item.source.key, hash: item.hash })
        return { source: item.source, rows: item.active }
      }
      const previous = item.active.at(-1)
      const row: Snapshot = {
        source: item.source.key,
        session_id: input.sessionID,
        message_id: input.messageID,
        hash: item.hash!,
        snapshot: item.value,
        kind: previous ? "update" : "initial",
        text: previous ? item.source.changed(previous.snapshot, item.value) : item.source.initial(item.value),
      }
      db.insert(InstructionSnapshotTable).values(row).run()
      log.info("source snapshot committed", {
        sessionID: input.sessionID,
        source: row.source,
        messageID: row.message_id,
        kind: row.kind,
        hash: row.hash,
        chars: row.text.length,
      })
      return { source: item.source, rows: [...item.active, row] }
    })
  })
  const updates = new Map<MessageID, string[]>()
  const system: string[] = []
  for (const state of states) {
    const first = state.rows[0]
    const baseline = first.kind === "initial" ? first.text : state.source.initial(first.snapshot)
    if (baseline) system.push(baseline)
    for (const row of state.rows.slice(1))
      if (row.text) {
        const group = updates.get(row.message_id) ?? []
        group.push(row.text)
        updates.set(row.message_id, group)
      }
  }
  const notification = (id: MessageID, texts: string[]): MessageV2.WithParts => {
    const messageID = MessageID.make(`msg_instructions_${id.slice(4)}`)
    return {
      info: { ...input.user, id: messageID, system: undefined },
      parts: [
        {
          type: "text",
          synthetic: true,
          id: PartID.make(`prt_instructions_${id.slice(4)}`),
          sessionID: input.sessionID,
          messageID,
          text: `<system-reminder>\n${texts.join("\n\n")}\n</system-reminder>`,
        },
      ],
    }
  }
  const messages = input.messages.flatMap((message) => {
    const update = updates.get(message.info.id)
    updates.delete(message.info.id)
    return update ? [notification(message.info.id, update), message] : [message]
  })
  for (const [id, texts] of updates) messages.push(notification(id, texts))
  log.info("instruction context assembled", {
    sessionID: input.sessionID,
    sources: states.length,
    baselines: system.length,
    updates: states.reduce((count, item) => count + item.rows.length - 1, 0),
  })
  return { system, messages }
})

export function copy(source: SessionID, target: SessionID, ids: ReadonlyMap<string, MessageID>) {
  Database.transaction((db) => {
    const rows = db.select().from(InstructionSnapshotTable).where(eq(InstructionSnapshotTable.session_id, source)).all()
    let copied = 0
    for (const row of rows) {
      const id = ids.get(row.message_id)
      if (!id) continue
      db.insert(InstructionSnapshotTable)
        .values({ ...row, session_id: target, message_id: id })
        .run()
      copied++
    }
    log.info("instruction fork snapshots copied", { source, target, copied })
  })
}
export * as SessionInstructionState from "./instruction-state"
