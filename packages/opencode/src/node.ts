import { Database as StorageDatabase } from "@/storage/db"
import { JsonMigration } from "@/storage/json-migration"
import { Context, Effect, Layer } from "effect"
import { Issue } from "@/issue/issue"

export { Config } from "@/config/config"
export { Server } from "./server/server"
export { bootstrap } from "./cli/bootstrap"
export * as Log from "@opencode-ai/core/util/log"

interface DatabaseStartup {
  readonly migrated: true
}

class DatabaseStartupService extends Context.Service<DatabaseStartupService, DatabaseStartup>()(
  "@opencode/DatabaseStartup",
) {}

const databaseStartupLayer = Layer.effect(
  DatabaseStartupService,
  Effect.promise(async () => {
    await JsonMigration.run(StorageDatabase.Client())
    return { migrated: true }
  }),
)

export const Database = {
  ...StorageDatabase,
  defaultLayer: databaseStartupLayer,
}
export { JsonMigration }

export function recordDesktopIssue(input: { message: string; details?: string; fatal: boolean }) {
  return Issue.record(process.cwd(), {
    source: "sidecar",
    scope: "application",
    code: input.fatal ? "sidecar.failed" : "sidecar.rejection",
    state: input.fatal ? "failed" : "recorded",
    key: input.fatal ? "lifecycle" : input.message,
    message: input.message,
    details: input.details,
  })
}

export function recordDesktopRecovery() {
  for (const issue of Issue.list({ directory: process.cwd(), limit: 100 }).filter(
    (item) => item.source === "sidecar" && item.state === "failed",
  )) {
    Issue.record(process.cwd(), { ...issue, state: "resolved", message: "The local backend restarted successfully." })
  }
}
