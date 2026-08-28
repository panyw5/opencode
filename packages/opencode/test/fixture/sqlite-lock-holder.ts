import { Database } from "bun:sqlite"
import { writeFileSync } from "node:fs"

const [databasePath, readyPath, holdMsText] = process.argv.slice(2)
if (!databasePath || !readyPath || !holdMsText) {
  throw new Error("usage: sqlite-lock-holder.ts <database> <ready-file> <hold-ms>")
}

const holdMs = Number(holdMsText)
const database = new Database(databasePath)
const signal = new Int32Array(new SharedArrayBuffer(4))

try {
  database.run("PRAGMA busy_timeout = 5000")
  database.run("BEGIN IMMEDIATE")
  writeFileSync(readyPath, String(process.pid), "utf8")
  Atomics.wait(signal, 0, 0, holdMs)
  database.run("ROLLBACK")
} finally {
  database.close()
}
