import { Schema } from "effect"
import { Contributes, ExtensionID, Source } from "./schema"

export const OperationID = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))
export const ExtensionOperationHeaders = Schema.Struct({
  "x-opencode-extension-token": Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}\.[a-f0-9]{64}$/)),
})
export const ExtensionInstallSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("npm"), spec: Schema.String }),
  Schema.Struct({ type: Schema.Literal("archive"), url: Schema.String, sha256: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("release"), url: Schema.String }),
])
export const ExtensionPrepareInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("install"),
    source: ExtensionInstallSource,
    version: Schema.optionalKey(Schema.Never),
    target: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    kind: Schema.Literal("update"),
    id: ExtensionID,
    source: ExtensionInstallSource,
    version: Schema.optionalKey(Schema.Never),
    target: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    kind: Schema.Literal("update"),
    id: ExtensionID,
    version: Schema.String,
    source: Schema.optionalKey(Schema.Never),
    target: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    kind: Schema.Literal("update"),
    id: ExtensionID,
    target: Schema.Literal("release-current"),
    source: Schema.optionalKey(Schema.Never),
    version: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    kind: Schema.Literal("uninstall"),
    id: ExtensionID,
    purgeData: Schema.optional(Schema.Boolean),
    source: Schema.optionalKey(Schema.Never),
    version: Schema.optionalKey(Schema.Never),
    target: Schema.optionalKey(Schema.Never),
  }),
]).annotate({ identifier: "ExtensionPrepareInput" })
export const ExtensionInstallInput = Schema.Struct({
  operationId: OperationID,
  enable: Schema.optional(Schema.Boolean),
  acceptRegistryUpgrade: Schema.optional(Schema.Boolean),
})
export const ExtensionUpdateInput = Schema.Struct({
  operationId: OperationID,
  acceptRegistryUpgrade: Schema.optional(Schema.Boolean),
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
  signatureStatus: Schema.optional(Schema.Literals(["verified", "unsigned"])),
  releaseSequence: Schema.optional(Schema.Number),
  expectedRevision: Schema.optional(Schema.Number),
  expectedRegistryVersion: Schema.optional(Schema.Number),
  registryUpgrade: Schema.optional(Schema.Struct({ from: Schema.Literal(2), to: Schema.Literal(3) })),
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
const LeaseNamespace = Schema.Literals(["generation", "operation", "data"])
export const ExtensionUnlockResult = Schema.Struct({
  removed: Schema.Array(LeaseNamespace),
  recent: Schema.Array(LeaseNamespace),
  untrusted: Schema.Array(LeaseNamespace),
}).annotate({ identifier: "ExtensionUnlockResult" })
export const ExtensionOperationStatus = Schema.Union([
  Schema.Struct({ ...preview, state: Schema.Literal("prepared"), committed: Schema.Literal(false) }),
  ExtensionInstallResult,
]).annotate({ identifier: "ExtensionOperationStatus" })
