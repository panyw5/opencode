import { Database as StorageDatabase } from "@/storage/db"
import { JsonMigration } from "@/storage/json-migration"
import { Context, Effect, Layer } from "effect"

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
// Desktop sidecar drives managed local-archive installs through the same
// installation service the CLI and HTTP API use; HTTP stays CLI-only for
// local paths.
export { installation } from "@/extension/install-service"
export type { InstallationService } from "@/extension/install-service"
export { ExtensionRegistry } from "@/extension/registry"
export { purgeRetainedData } from "@/extension/install-service"
