import { Schema, Types } from "effect"

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
export const CONTRIBUTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
export const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/
export const SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/
export const ACTIVATION_PATTERN =
  /^(onStartup|onFileViewer:[a-z0-9][a-z0-9._-]*|onTool:[A-Za-z][A-Za-z0-9_.-]*|onCommand:[a-z0-9][a-z0-9._-]*|onPanel:[a-z0-9][a-z0-9._-]*)$/

export const ExtensionID = Schema.String.check(
  Schema.isPattern(ID_PATTERN),
  Schema.makeFilter((value) => value.length <= 64, {
    description: "Extension id must be at most 64 characters",
  }),
).pipe(Schema.brand("ExtensionID"))
export type ExtensionID = typeof ExtensionID.Type

export const ContributionID = Schema.String.check(Schema.isPattern(CONTRIBUTION_ID_PATTERN))
export const ToolName = Schema.String.check(Schema.isPattern(TOOL_NAME_PATTERN))
export const SettingKey = Schema.String.check(Schema.isPattern(SETTING_KEY_PATTERN))
export const Activation = Schema.String.check(Schema.isPattern(ACTIVATION_PATTERN))

export const FileViewerContribution = Schema.Struct({
  id: ContributionID,
  title: Schema.String,
  extensions: Schema.optional(Schema.Array(Schema.String)),
  filenames: Schema.optional(Schema.Array(Schema.String)),
  mime: Schema.optional(Schema.Array(Schema.String)),
  priority: Schema.optional(Schema.Number.check(Schema.isFinite())),
  mode: Schema.optional(Schema.Literals(["replace", "preview"])),
  content: Schema.optional(Schema.Literals(["text", "self"])),
}).annotate({ identifier: "ExtensionFileViewerContribution" })
export type FileViewerContribution = Types.DeepMutable<Schema.Schema.Type<typeof FileViewerContribution>>

export const ToolRendererContribution = Schema.Struct({
  tool: ToolName,
}).annotate({ identifier: "ExtensionToolRendererContribution" })
export type ToolRendererContribution = Types.DeepMutable<Schema.Schema.Type<typeof ToolRendererContribution>>

export const CommandContribution = Schema.Struct({
  id: ContributionID,
  title: Schema.String,
  category: Schema.optional(Schema.String),
  keybind: Schema.optional(Schema.String),
  slash: Schema.optional(Schema.String),
}).annotate({ identifier: "ExtensionCommandContribution" })
export type CommandContribution = Types.DeepMutable<Schema.Schema.Type<typeof CommandContribution>>

export const PanelContribution = Schema.Struct({
  id: ContributionID,
  title: Schema.String,
  icon: Schema.optional(Schema.String),
}).annotate({ identifier: "ExtensionPanelContribution" })
export type PanelContribution = Types.DeepMutable<Schema.Schema.Type<typeof PanelContribution>>

export const SettingDefinition = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean"]),
  title: Schema.String,
  description: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  enum: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  secret: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ExtensionSettingDefinition" })
export type SettingDefinition = Types.DeepMutable<Schema.Schema.Type<typeof SettingDefinition>>

export const Contributes = Schema.Struct({
  fileViewers: Schema.optional(Schema.Array(FileViewerContribution)),
  toolRenderers: Schema.optional(Schema.Array(ToolRendererContribution)),
  commands: Schema.optional(Schema.Array(CommandContribution)),
  panels: Schema.optional(Schema.Array(PanelContribution)),
  settings: Schema.optional(Schema.Record(SettingKey, SettingDefinition)),
}).annotate({ identifier: "ExtensionContributes" })
export type Contributes = Types.DeepMutable<Schema.Schema.Type<typeof Contributes>>

// The host implements exactly this web API version. Manifests may declare any
// number so decoding succeeds; manifest.ts degrades unsupported versions
// gracefully by skipping the web part instead of rejecting the extension.
export const WEB_API_VERSION = 1

export const Web = Schema.Struct({
  apiVersion: Schema.Number,
  styles: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "ExtensionWebManifest" })
export type Web = Types.DeepMutable<Schema.Schema.Type<typeof Web>>

export const SERVER_API_VERSION = 1

/**
 * Server half of the manifest (remediation T5.3). `isolation` selects the
 * execution backend: the default `inline` keeps the historical in-process
 * behavior, `process` routes the server entry through a supervised
 * `extension-host` worker process. `apiVersion` gates the server surface the
 * same way `web.apiVersion` gates the web surface (decision Q10): an unknown
 * version drops the whole server part with a stable warning code.
 */
export const Server = Schema.Struct({
  isolation: Schema.optional(Schema.Literals(["inline", "process"])),
  // Omitted means the current version — extensions opt into isolation without
  // having to restate the API level (extension-kit types it optional too).
  apiVersion: Schema.optional(Schema.Number),
}).annotate({ identifier: "ExtensionServerManifest" })
export type Server = Types.DeepMutable<Schema.Schema.Type<typeof Server>>
export type IsolationMode = "inline" | "process"

// Declared capabilities are self-reported by the extension. Unknown entries
// stay valid for forward compatibility: manifest.ts logs a warning and the
// UI marks them as unknown. Under process isolation the host coarsely
// enforces `tools` and `process:spawn` (T5.6, design §6); every other entry —
// and the inline backend — stays declaration-only.
export const PERMISSIONS = ["fs:read", "fs:write", "process:spawn", "network", "tools", "settings:secret"] as const
export type Permission = (typeof PERMISSIONS)[number]

export const Manifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: ExtensionID,
  displayName: Schema.String,
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  web: Schema.optional(Web),
  server: Schema.optional(Server),
  activation: Schema.optional(Schema.Array(Activation)),
  contributes: Schema.optional(Contributes),
  permissions: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "ExtensionManifest" })
export type Manifest = Types.DeepMutable<Schema.Schema.Type<typeof Manifest>>

export const PathSource = Schema.Struct({
  type: Schema.Literal("path"),
  path: Schema.String,
}).annotate({ identifier: "ExtensionPathSource" })

export const NpmSource = Schema.Struct({
  type: Schema.Literal("npm"),
  spec: Schema.String,
  registry: Schema.String,
  integrity: Schema.String,
}).annotate({ identifier: "ExtensionNpmSource" })

export const ArchiveSource = Schema.Struct({
  type: Schema.Literal("archive"),
  location: Schema.String,
  sha256: Schema.String,
}).annotate({ identifier: "ExtensionArchiveSource" })

export const LegacySource = Schema.Union([PathSource, NpmSource, ArchiveSource])

// Persist only canonical public locations. Signed artifact queries are private
// operation state, never part of the registry, SDK, or stable source identity.
const ReleaseLocation = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value)
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          !value.includes("?") &&
          !value.includes("#") &&
          url.href === value
        )
      } catch {
        return false
      }
    },
    { description: "Expected a canonical HTTPS URL without credentials, query, or fragment" },
  ),
)
const ReleaseDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const ReleaseSource = Schema.Struct({
  type: Schema.Literal("release"),
  descriptor: ReleaseLocation,
  extensionID: ExtensionID,
  version: Schema.String,
  artifact: ReleaseLocation,
  sha256: ReleaseDigest,
  descriptorSha256: ReleaseDigest,
}).annotate({ identifier: "ExtensionReleaseSource" })

export const Source = Schema.Union([LegacySource, ReleaseSource])
export type Source = Types.DeepMutable<Schema.Schema.Type<typeof Source>>

const registryRow = {
  name: Schema.String,
  version: Schema.String,
  source: Source,
  // Stable data-ownership lineage across explicitly confirmed archive updates.
  dataSource: Schema.optional(ArchiveSource),
  dir: Schema.String,
  enabled: Schema.Boolean,
  installedAt: Schema.Number,
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  revision: Schema.optional(Schema.Number),
  installId: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.Number),
  secretKeys: Schema.optional(Schema.Array(Schema.String)),
  // Last accepted signed-descriptor sequence; release-current updates refuse regressions.
  releaseSequence: Schema.optional(Schema.Number),
}
export const RegistryRow = Schema.Struct(registryRow).annotate({ identifier: "ExtensionRegistryRow" })
export type RegistryRow = Types.DeepMutable<Schema.Schema.Type<typeof RegistryRow>>

export const OperationReceipt = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["install", "update", "uninstall"]),
  extensionID: ExtensionID,
  tokenHash: Schema.String,
  committedAt: Schema.Number,
  installId: Schema.optional(Schema.String),
  cleanupPending: Schema.Boolean,
  purgeData: Schema.optional(Schema.Boolean),
  purgeCompleted: Schema.optional(Schema.Boolean),
  previousInstallId: Schema.optional(Schema.String),
  retainedRevision: Schema.optional(Schema.Number),
}).annotate({ identifier: "ExtensionOperationReceipt" })
export type OperationReceipt = Types.DeepMutable<Schema.Schema.Type<typeof OperationReceipt>>

const retainedData = {
  name: Schema.String,
  source: Source,
  dataSource: Schema.optional(ArchiveSource),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  secretKeys: Schema.Array(Schema.String),
  revision: Schema.Number,
  purging: Schema.optional(Schema.Boolean),
  purgeRevision: Schema.optional(Schema.Number),
  purgedAt: Schema.optional(Schema.Number),
}
export const RetainedData = Schema.Struct(retainedData).annotate({ identifier: "ExtensionRetainedData" })
export type RetainedData = Types.DeepMutable<Schema.Schema.Type<typeof RetainedData>>

const registryStore = {
  revision: Schema.optional(Schema.Number),
  receipts: Schema.optional(Schema.Record(Schema.String, OperationReceipt)),
}
export const RegistryStore = Schema.Union([
  Schema.Struct({
    ...registryStore,
    version: Schema.Literals([1, 2]),
    extensions: Schema.Record(ExtensionID, Schema.Struct({ ...registryRow, source: LegacySource })),
    retained: Schema.optional(Schema.Record(ExtensionID, Schema.Struct({ ...retainedData, source: LegacySource }))),
  }),
  Schema.Struct({
    ...registryStore,
    version: Schema.Literal(3),
    extensions: Schema.Record(ExtensionID, RegistryRow),
    retained: Schema.optional(Schema.Record(ExtensionID, RetainedData)),
  }),
]).annotate({ identifier: "ExtensionRegistry" })
export type RegistryStore = Types.DeepMutable<Schema.Schema.Type<typeof RegistryStore>>

export const State = Schema.Literals(["ready", "disabled", "error", "incompatible"])
export type State = Schema.Schema.Type<typeof State>

export const WebInfo = Schema.Struct({
  base: Schema.String,
  entry: Schema.optional(Schema.String),
  styles: Schema.Array(Schema.String),
  apiVersion: Schema.Literal(1),
}).annotate({ identifier: "ExtensionWebInfo" })
export type WebInfo = Types.DeepMutable<Schema.Schema.Type<typeof WebInfo>>

export const ServerInfo = Schema.Struct({
  hasService: Schema.Boolean,
  hasInstanceHooks: Schema.Boolean,
  runtime: Schema.Literals(["idle", "loading", "ready", "error", "blocked"]),
  error: Schema.optional(Schema.String),
  needsRestart: Schema.Boolean,
}).annotate({ identifier: "ExtensionServerInfo" })
export type ServerInfo = Types.DeepMutable<Schema.Schema.Type<typeof ServerInfo>>

export const Info = Schema.Struct({
  id: ExtensionID,
  name: Schema.String,
  version: Schema.String,
  displayName: Schema.String,
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  source: Source,
  enabled: Schema.Boolean,
  state: State,
  error: Schema.optional(Schema.String),
  // Stable machine-oriented warning codes, e.g. "web.apiVersion:2" when the
  // declared web API version was dropped as unsupported. UI maps known codes
  // to localized messages and shows unknown entries verbatim.
  warnings: Schema.optional(Schema.Array(Schema.String)),
  activation: Schema.Array(Schema.String),
  contributes: Contributes,
  permissions: Schema.Array(Schema.String),
  revision: Schema.optional(Schema.Number),
  installId: Schema.optional(Schema.String),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  server: Schema.optional(ServerInfo),
  web: Schema.optional(WebInfo),
}).annotate({ identifier: "ExtensionInfo" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const StatusState = Schema.Literals([
  "installed",
  "enabled",
  "disabled",
  "error",
  "blocked",
  "changed",
  "removed",
])
export const StatusProperties = Schema.Struct({
  id: ExtensionID,
  version: Schema.String,
  state: StatusState,
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "ExtensionStatusProperties" })
export type StatusProperties = Types.DeepMutable<Schema.Schema.Type<typeof StatusProperties>>

export const SetEnabledInput = Schema.Struct({
  enabled: Schema.Boolean,
}).annotate({ identifier: "ExtensionSetEnabledInput" })
export type SetEnabledInput = Types.DeepMutable<Schema.Schema.Type<typeof SetEnabledInput>>

export * as ExtensionSchema from "./schema"
