import type { LogicalPath, PathContext } from "@opencode-ai/core/util/path"

export type AuthorityKey = string & { readonly authority: unique symbol }
export type WorkspaceID = string & { readonly workspace: unique symbol }
export type SessionKey = string & { readonly session: unique symbol }
export type DraftKey = string & { readonly draft: unique symbol }
export type WindowID = string & { readonly window: unique symbol }
export type RestoreSlotID = string & { readonly restoreSlot: unique symbol }

export type RuntimeScope = Readonly<{
  authority: AuthorityKey
  domain: string
  generation: number
}>

export type WindowScope = Readonly<{
  id: WindowID
  restoreSlot: RestoreSlotID
}>

export type WorkspaceRef = Readonly<{
  authority: AuthorityKey
  id: WorkspaceID
  kind: "filesystem" | "virtual"
  directory: LogicalPath
  filesystem: "posix" | "windows" | "opaque"
}>

export type ClientErrorCode =
  | "invalid-input"
  | "unsupported"
  | "not-found"
  | "not-directory"
  | "unauthenticated"
  | "forbidden"
  | "unavailable"
  | "stale-scope"
  | "conflict"

export class ClientError extends Error {
  readonly name = "ClientError"

  constructor(
    readonly code: ClientErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type AuthoritySource =
  | { kind: "sidecar"; profile: string; connection: string }
  | { kind: "http"; url: string }
  | { kind: "ssh"; profile: string; connection: string }
  | { kind: "wsl"; profile: string; distro: string }

/** Managed endpoints are deliberately absent: restarting a host must not rename its data. */
export function authorityKey(source: AuthoritySource): AuthorityKey {
  if (source.kind === "http") {
    const url = (() => {
      try {
        return new URL(source.url)
      } catch {
        throw new ClientError("invalid-input", "An HTTP authority requires a valid endpoint")
      }
    })()
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new ClientError("invalid-input", "An HTTP authority requires an HTTP(S) endpoint")
    }
    // Authentication and request parameters are transport state, never persistent identity.
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return JSON.stringify(["authority", "http", url.origin, url.pathname.replace(/\/+$/, "")]) as AuthorityKey
  }
  if (!source.profile || (source.kind === "wsl" ? !source.distro : !source.connection)) {
    throw new ClientError("invalid-input", "A managed authority requires a profile and connection identity")
  }
  return JSON.stringify([
    "authority",
    source.kind,
    source.profile,
    source.kind === "wsl" ? source.distro : source.connection,
  ]) as AuthorityKey
}

type EntityScope = Pick<RuntimeScope, "authority" | "domain">

export function sessionKey(scope: EntityScope, sessionID: string): SessionKey {
  return JSON.stringify(["session", scope.authority, scope.domain, sessionID]) as SessionKey
}

export function workspaceKey(scope: EntityScope, ref: WorkspaceRef): string {
  if (scope.authority !== ref.authority) throw new ClientError("stale-scope", "Workspace belongs to another authority")
  return JSON.stringify(["workspace", scope.authority, scope.domain, ref.id])
}

export function draftKey(scope: EntityScope, ref: WorkspaceRef, draftID: string): DraftKey {
  return JSON.stringify(["draft", workspaceKey(scope, ref), draftID]) as DraftKey
}

export const operations = [
  "directory.resolve",
  "directory.list",
  "session.read",
  "session.send",
  "permission.reply",
  "file.read",
  "vcs.read",
  "terminal.open",
  "host.admin",
  "editor.open",
  "client.reload",
  "host.restart",
] as const

export type Operation = (typeof operations)[number]
export type Capability = { supported: true } | { supported: false; reason: ClientErrorCode }
export type Capabilities = Readonly<Record<Operation, Capability>>

/** Missing manifests or dimensions never imply authority to perform an operation. */
export function effectiveCapabilities(...manifests: ReadonlyArray<Partial<Capabilities>>): Capabilities {
  return Object.fromEntries(
    operations.map((operation) => {
      const values = manifests.map((manifest) => manifest[operation])
      const denied = values.find((value) => value && !value.supported)
      return [
        operation,
        denied ??
          (values.length > 0 && values.every((value) => value?.supported)
            ? { supported: true }
            : { supported: false, reason: "unsupported" }),
      ]
    }),
  ) as Capabilities
}

export type HostDirectory = Readonly<{ directory: LogicalPath; context: PathContext }>

export interface HostDirectoryPort {
  resolve(input: string, options: { base?: LogicalPath; signal: AbortSignal }): Promise<HostDirectory>
}

export interface ClientLifecyclePort {
  reloadClient(): Promise<void>
  restartHost(): Promise<void>
}
