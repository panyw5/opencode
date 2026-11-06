#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log(
    existsSync(join(process.env.DSH_HOME, "legacy"))
      ? "Usage: dsh headless [task]"
      : "Options: --json --session-id <id> --permission-mode <preset> --approval-policy <policy> --add-dir <path>",
  )
  process.exit(0)
}
const patches = args.flatMap((arg, index) => (arg === "--patch" ? [readFileSync(args[index + 1], "utf8")] : []))
appendFileSync(join(process.env.DSH_HOME, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), patches }) + "\n")
const emit = (event) => console.log(JSON.stringify(event))
emit({ type: "session", sessionId: "session-dsh-fixture" })
emit({ type: "status", phase: "turn_end", reason: { kind: "completed" } })
emit({ type: "final", text: args.includes("--session-id") ? "Follow-up fixture answer" : "Initial fixture answer" })
