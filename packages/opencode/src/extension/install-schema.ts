import { Schema } from "effect"
import { Contributes, ExtensionID, Source } from "./schema"

export const OperationID = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))
export const ExtensionOperationHeaders = Schema.Struct({
  "x-opencode-extension-token": Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.[a-f0-9]{64}$/)),
})
export const ExtensionInstallSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("npm"), spec: Schema.String }),
  Schema.Struct({ type: Schema.Literal("archive"), url: Schema.String, sha256: Schema.String }),
])
export const ExtensionPrepareInput = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("install"), source: ExtensionInstallSource }),
  Schema.Struct({ kind: Schema.Literal("update"), id: ExtensionID, source: ExtensionInstallSource }),
  Schema.Struct({ kind: Schema.Literal("update"), id: ExtensionID, version: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("uninstall"), id: ExtensionID, purgeData: Schema.optional(Schema.Boolean) }),
]).annotate({ identifier: "ExtensionPrepareInput" })
export const ExtensionInstallInput = Schema.Struct({
  operationId: OperationID,
  enable: Schema.optional(Schema.Boolean),
})
export const ExtensionCommitInput = Schema.Struct({ operationId: OperationID })

const preview = {
  operationId: OperationID,
  expiresAt: Schema.Number,
  kind: Schema.Literals(["install", "update", "uninstall"]),
  id: ExtensionID,
  name: Schema.String,
  oldVersion: Schema.optional(Schema.String),
  version: Schema.String,
  versionChange: Schema.optional(Schema.Literals(["upgrade", "same-version", "downgrade"])),
  sameVersion: Schema.optional(Schema.Boolean),
  downgrade: Schema.optional(Schema.Boolean),
  permissions: Schema.Array(Schema.String),
  permissionsAdded: Schema.Array(Schema.String),
  permissionsRemoved: Schema.Array(Schema.String),
  contributes: Contributes,
  source: Source,
  expectedRevision: Schema.optional(Schema.Number),
  hasServer: Schema.Boolean,
  enable: Schema.Boolean,
  installId: Schema.optional(Schema.String),
}
export const ExtensionInstallPreview = Schema.Struct(preview).annotate({ identifier: "ExtensionInstallPreview" })
export const ExtensionPreparedOperation = Schema.Struct({ ...preview, token: Schema.String }).annotate({
  identifier: "ExtensionPreparedOperation",
})
export const ExtensionInstallResult = Schema.Struct({
  operationId: OperationID,
  kind: Schema.Literals(["install", "update", "uninstall"]),
  id: ExtensionID,
  installId: Schema.optional(Schema.String),
  state: Schema.Literals(["committed", "cancelled", "expired", "failed", "unknown"]),
  committed: Schema.optional(Schema.Boolean),
  synced: Schema.Boolean,
  cleanupPending: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "ExtensionInstallResult" })
export const ExtensionOperationStatus = Schema.Union([
  Schema.Struct({ ...preview, state: Schema.Literal("prepared"), committed: Schema.Literal(false) }),
  ExtensionInstallResult,
]).annotate({ identifier: "ExtensionOperationStatus" })
