import { Database as SQLite } from "bun:sqlite"
import path from "node:path"
import { FileChange } from "../src/session/file-change"
import type { MessageV2 } from "../src/session/message-v2"

const [directory, sessionID, mode] = process.argv.slice(2)
if (!directory || !sessionID || (mode && mode !== "--apply")) {
  throw new Error(
    "Usage: OPENCODE_DB=/absolute/path.db bun script/repair-session-diffs.ts <directory> <sessionID> [--apply]",
  )
}
const { getPath } = await import("../src/storage/db")
const db = new SQLite(getPath(), { readonly: true })
const session = db.query("SELECT directory FROM session WHERE id=?").get(sessionID) as { directory: string } | null
if (!session || path.resolve(session.directory) !== path.resolve(directory))
  throw new Error("Session directory does not match")
const rows = db.query("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created,id").all(sessionID) as {
  id: string
  data: string
}[]
const messages = rows.map((row) => ({
  info: { ...JSON.parse(row.data), id: row.id, sessionID },
  parts: (
    db.query("SELECT id,data FROM part WHERE message_id=? ORDER BY time_created,id").all(row.id) as {
      id: string
      data: string
    }[]
  ).map((part) => ({ ...JSON.parse(part.data), id: part.id, messageID: row.id, sessionID })),
})) as MessageV2.WithParts[]
db.close()
for (const message of messages) {
  if (message.info.role !== "user") continue
  const owned = FileChange.diffs(
    messages.filter((candidate) => candidate.info.role === "assistant" && candidate.info.parentID === message.info.id),
  )
  console.log(
    JSON.stringify({
      messageID: message.info.id,
      previousFiles: message.info.summary?.diffs.map((diff) => diff.file) ?? [],
      nextFiles: owned.map((diff) => diff.file),
      incomplete: owned.some((diff) => diff.incomplete),
    }),
  )
}
if (mode !== "--apply") {
  console.log("Dry run only; no session data changed.")
  process.exit(0)
}
const { Effect } = await import("effect")
const { makeRuntime } = await import("../src/effect/run-service")
const { InstanceRef } = await import("../src/effect/instance-ref")
const { InstanceRuntime } = await import("../src/project/instance-runtime")
const { SessionSummary } = await import("../src/session/summary")
const { SessionID } = await import("../src/session/schema")
const Log = await import("@opencode-ai/core/util/log")
await Log.init({ level: "INFO", print: false })
const instance = await InstanceRuntime.load({ directory })
try {
  const runtime = makeRuntime(SessionSummary.Service, SessionSummary.defaultLayer)
  await runtime.runPromise((summary) =>
    summary.repair(SessionID.make(sessionID)).pipe(Effect.provideService(InstanceRef, instance)),
  )
  console.log("Applied versioned summary repair; original summaries are retained in session_diff_backup.")
} finally {
  await InstanceRuntime.disposeInstance(instance)
}
process.exit(0)
