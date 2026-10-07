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

export const Web = Schema.Struct({
  apiVersion: Schema.Literal(1),
  styles: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "ExtensionWebManifest" })
export type Web = Types.DeepMutable<Schema.Schema.Type<typeof Web>>

export const Manifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: ExtensionID,
  displayName: Schema.String,
  description: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  web: Schema.optional(Web),
  activation: Schema.optional(Schema.Array(Activation)),
  contributes: Schema.optional(Contributes),
  permissions: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "ExtensionManifest" })
export type Manifest = Types.DeepMutable<Schema.Schema.Type<typeof Manifest>>

export const Source = Schema.Struct({
  type: Schema.Literal("path"),
  path: Schema.String,
}).annotate({ identifier: "ExtensionPathSource" })
export type Source = Types.DeepMutable<Schema.Schema.Type<typeof Source>>

export const RegistryRow = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  source: Source,
  dir: Schema.String,
  enabled: Schema.Boolean,
  installedAt: Schema.Number,
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
}).annotate({ identifier: "ExtensionRegistryRow" })
export type RegistryRow = Types.DeepMutable<Schema.Schema.Type<typeof RegistryRow>>

export const RegistryStore = Schema.Struct({
  version: Schema.Literal(1),
  extensions: Schema.Record(ExtensionID, RegistryRow),
}).annotate({ identifier: "ExtensionRegistry" })
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
  activation: Schema.Array(Schema.String),
  contributes: Contributes,
  permissions: Schema.Array(Schema.String),
  settings: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  server: Schema.optional(ServerInfo),
  web: Schema.optional(WebInfo),
}).annotate({ identifier: "ExtensionInfo" })
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const StatusState = Schema.Literals(["installed", "enabled", "disabled", "error", "changed"])
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
