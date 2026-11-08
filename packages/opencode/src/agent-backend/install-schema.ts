import { Schema } from "effect"
import { BackendConfig } from "./schema"

export const ManagedAdvisor = Schema.Literals(["claude", "codex", "pi"])
export const AdvisorID = Schema.Literals(["claude", "codex", "pi", "grok", "dsh"])
export const InstallAction = Schema.Literals(["install", "remove"])
export const PrepareInput = Schema.Struct({ advisor: ManagedAdvisor, version: Schema.String, action: InstallAction })
export const PreparedInstall = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.Number,
  advisor: ManagedAdvisor,
  version: Schema.String,
  action: InstallAction,
  package: Schema.String,
  source: Schema.String,
  integrity: Schema.String,
  target: Schema.String,
  directory: Schema.String,
})
export const InstalledAdapter = Schema.Struct({
  version: Schema.String,
  installedAt: Schema.Number,
  command: Schema.Array(Schema.String),
})
export const AdapterStatus = Schema.Struct({
  advisor: ManagedAdvisor,
  package: Schema.String,
  source: Schema.String,
  loginHelp: Schema.String,
  requires: Schema.Array(Schema.String),
  recommended: Schema.String,
  releases: Schema.Array(Schema.String),
  installed: Schema.Array(InstalledAdapter),
})
export const InstallStatus = Schema.Struct({
  target: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  directory: Schema.String,
  node: Schema.NullOr(Schema.String),
  npm: Schema.NullOr(Schema.String),
  adapters: Schema.Array(AdapterStatus),
})
export const ProbeInput = Schema.Struct({
  advisor: AdvisorID,
  config: BackendConfig,
  authMethod: Schema.optional(Schema.String),
  message: Schema.optional(Schema.Boolean),
})
export const ProbeResult = Schema.Struct({
  status: Schema.Literals(["ready", "authentication_required", "error"]),
  message: Schema.String,
  authMethods: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.optional(Schema.String),
      type: Schema.Literals(["agent", "env_var", "terminal"]),
      environment: Schema.Array(Schema.String),
    }),
  ),
  response: Schema.optional(Schema.String),
})
export type ProbeResult = typeof ProbeResult.Type
