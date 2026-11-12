import type { ExtensionInfo, FileViewerContribution } from "../extensions/types"

type WireNumber = number | "NaN" | "Infinity" | "-Infinity"

export type InstallationSource =
  | { type: "npm"; spec: string }
  | { type: "archive"; url: string; sha256?: string }
  | { type: "release"; url: string }
  /** Desktop-only: a local .tgz path, installed through the desktop IPC channel. */
  | { type: "local"; path: string; sha256: string }
export type InstallationRequest =
  | { kind: "install"; source: InstallationSource }
  | { kind: "update"; id: string; version: string }
  | { kind: "update"; id: string; target: "release-current" }
  | { kind: "update"; id: string; source: InstallationSource }
  | { kind: "uninstall"; id: string; purgeData?: boolean }

// Structural counterparts of extensions/install-api.ts. No generated SDK dependency is needed by the view.
export interface PreparedInstallation {
  operationId: string
  expiresAt: WireNumber
  kind: InstallationRequest["kind"]
  id: string
  name: string
  oldVersion?: string
  version: string
  versionChange?: "upgrade" | "same-version" | "downgrade"
  sameVersion?: boolean
  downgrade?: boolean
  permissions: string[]
  permissionsAdded: string[]
  permissionsRemoved: string[]
  contributes: Omit<ExtensionInfo["contributes"], "fileViewers" | "settings"> & {
    fileViewers?: Array<Omit<FileViewerContribution, "priority"> & { priority?: number }>
    settings?: Record<string, unknown>
  }
  source: NonNullable<ExtensionInfo["source"]>
  expectedRevision?: WireNumber
  expectedRegistryVersion?: WireNumber
  registryUpgrade?: { from: 2; to: 3 }
  hasServer: boolean
  enable: boolean
  installId?: string
  token: string
}
export interface InstallationResult {
  operationId: string
  kind: InstallationRequest["kind"]
  id: string
  installId?: string
  state: "committed" | "cancelled" | "expired" | "failed" | "unknown"
  committed?: boolean
  synced: boolean
  cleanupPending: boolean
  warnings: string[]
}
export type InstallationStatus =
  | (Omit<PreparedInstallation, "token"> & { state: "prepared"; committed: false })
  | InstallationResult
export interface InstallationCommitInput {
  enable?: boolean
  acceptRegistryUpgrade?: boolean
}
export interface InstallationOperations {
  prepareInstallation(request: InstallationRequest): Promise<PreparedInstallation>
  commitInstallation(prepared: PreparedInstallation, input?: InstallationCommitInput): Promise<InstallationResult>
  cancelInstallation(prepared: PreparedInstallation): Promise<InstallationResult>
  installationStatus(prepared: PreparedInstallation): Promise<InstallationStatus>
}
export type InstallationIntent =
  | { kind: "install" }
  | { kind: "install"; localArchive: { path: string } }
  /** Catalog prefill: the install dialog opens with this release URL seeded. */
  | { kind: "install"; releaseUrl: string }
  | { kind: "update"; id: string; source?: ExtensionInfo["source"] }
  | { kind: "uninstall"; id: string }
export interface InstallationBlockedState {
  enabled?: boolean
  busy?: boolean
  dirty?: boolean
  saving?: boolean
  blocked?: boolean
}
export function installationBlocked(state: InstallationBlockedState) {
  return state.enabled === false || !!(state.busy || state.dirty || state.saving || state.blocked)
}
export type InstallationInput = {
  sourceType: "release" | "npm" | "archive" | "version" | "local"
  spec: string
  url: string
  sha256: string
  version: string
  purgeData: boolean
  localPath: string
}
/**
 * Rewrites a GitHub web "blob" page URL into the raw content URL for the same
 * file, so `https://github.com/{owner}/{repo}/blob/{ref}/{path}` becomes
 * `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`. Only exact
 * blob paths are rewritten — never gists, never other hosts — and the result
 * carries no credentials, query, or fragment.
 */
export function installationGitHubBlobUrl(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return
  // Dot segments must be explicit in the input; the parser would silently
  // resolve them away, so scan the raw path before trusting the rewrite.
  if (/\/\.{1,2}(?:\/|$)/.test(url.slice(parsed.origin.length))) return
  // Path form: /{owner}/{repo}/blob/{ref}/{...path}
  const segments = parsed.pathname.split("/").filter(Boolean)
  if (segments.length < 5 || segments[2] !== "blob") return
  const [owner, repo, , ref, ...path] = segments
  // Release sources are always .json manifests; other blob pages stay untouched.
  if (!path[path.length - 1]?.endsWith(".json")) return
  for (const segment of [owner, repo, ref, ...path]) if (!segment || segment === "." || segment === "..") return
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path.join("/")}`
}
export function installationRequest(
  intent: InstallationIntent,
  input: InstallationInput,
): InstallationRequest | undefined {
  if (intent.kind === "uninstall") return { kind: "uninstall", id: intent.id, purgeData: input.purgeData }
  if (intent.kind === "update" && intent.source?.type === "path") return
  if (intent.kind === "update" && intent.source?.type === "release")
    return { kind: "update", id: intent.id, target: "release-current" }
  if (input.sourceType === "version") {
    const version = input.version.trim()
    if (
      intent.kind !== "update" ||
      intent.source?.type !== "npm" ||
      !version ||
      version.length > 256 ||
      /[\s\x00-\x1f\x7f]/.test(version)
    )
      return
    return { kind: "update", id: intent.id, version }
  }
  let source: InstallationSource
  if (input.sourceType === "npm") {
    const spec = input.spec.trim()
    // Only registry packages, never local paths, git references, tarballs or URLs.
    if (
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[^\s/:\\\x00-\x1f\x7f]+)?$/i.test(spec) ||
      spec.length > 1024
    )
      return
    source = { type: "npm", spec }
  } else if (input.sourceType === "archive" || input.sourceType === "release") {
    const raw = input.url.trim()
    const sha256 = input.sha256.trim()
    if (/[\s\\\x00-\x1f\x7f]/.test(raw) || raw.length > 16384) return
    try {
      // A GitHub "blob" page URL is accepted for release descriptors and
      // rewritten to its raw.githubusercontent.com counterpart so pasting the
      // address from a browser works. Anything with credentials, query or
      // fragment is still rejected outright.
      const url = input.sourceType === "release" ? (installationGitHubBlobUrl(raw) ?? raw) : raw
      const parsed = new URL(url)
      if (!/^https:\/\//i.test(url) || parsed.protocol !== "https:" || parsed.username || parsed.password) return
      if (input.sourceType === "release" && (parsed.search || parsed.hash || /[?#]/.test(url))) return
      if (input.sourceType === "archive" && sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) return
      source =
        input.sourceType === "release"
          ? { type: "release", url: parsed.href }
          : { type: "archive", url, ...(sha256 ? { sha256: sha256.toLowerCase() } : {}) }
    } catch {
      return
    }
  } else if (input.sourceType === "local") {
    const path = input.localPath.trim()
    const sha256 = input.sha256.trim()
    if (
      intent.kind !== "install" ||
      !path ||
      path.length > 4096 ||
      !/\.tgz$/i.test(path) ||
      !/^[a-f0-9]{64}$/i.test(sha256)
    )
      return
    source = { type: "local", path, sha256: sha256.toLowerCase() }
  } else return
  return intent.kind === "install" ? { kind: "install", source } : { kind: "update", id: intent.id, source }
}
export function installationSourceLabel(source: PreparedInstallation["source"]) {
  if (source.type === "npm") return source.spec
  if (source.type === "path") return source.path
  const location = source.type === "release" ? source.descriptor : source.location
  try {
    const url = new URL(location)
    url.username = ""
    url.password = ""
    url.search = ""
    url.hash = ""
    return url.href
  } catch {
    return ""
  }
}
export function installationDownloadHost(source: PreparedInstallation["source"]) {
  if (source.type !== "release") return ""
  try {
    return new URL(source.artifact).host
  } catch {
    return ""
  }
}
// Do not forward service objects wholesale: capabilities must never reach callbacks, logs or the DOM.
export function installationPublicResult(result: InstallationResult, token: string): InstallationResult {
  return {
    operationId: result.operationId,
    kind: result.kind,
    id: result.id,
    installId: result.installId,
    state: result.state,
    committed: result.committed,
    synced: result.synced,
    cleanupPending: result.cleanupPending,
    warnings: result.warnings.map((warning) => (token ? warning.replaceAll(token, "[redacted]") : warning)),
  }
}
export function installationUnknown(prepared: PreparedInstallation): InstallationResult {
  return {
    operationId: prepared.operationId,
    kind: prepared.kind,
    id: prepared.id,
    state: "unknown",
    committed: undefined,
    synced: false,
    cleanupPending: false,
    warnings: [],
  }
}
export const installationTranslationKeys = [
  "config.extensions.install.title",
  "config.extensions.install.update",
  "config.extensions.install.uninstall",
  "config.extensions.install.release",
  "config.extensions.install.releaseUrl",
  "config.extensions.install.releaseCurrent",
  "config.extensions.install.downloadHost",
  "config.extensions.install.integrityMatched",
  "config.extensions.install.publisherUnsigned",
  "config.extensions.install.registryUpgradeWarning",
  "config.extensions.install.acceptRegistryUpgrade",
  "config.extensions.install.npm",
  "config.extensions.install.archive",
  "config.extensions.install.version",
  "config.extensions.install.spec",
  "config.extensions.install.url",
  "config.extensions.install.sha256",
  "config.extensions.install.preview",
  "config.extensions.install.previewUpdate",
  "config.extensions.install.previewUninstall",
  "config.extensions.install.confirm",
  "config.extensions.install.back",
  "config.extensions.install.cancel",
  "config.extensions.install.close",
  "config.extensions.install.busy",
  "config.extensions.install.invalid",
  "config.extensions.install.failed",
  "config.extensions.install.expired",
  "config.extensions.install.connectionChanged",
  "config.extensions.install.blocked",
  "config.extensions.install.enable",
  "config.extensions.install.purgeData",
  "config.extensions.install.keepData",
  "config.extensions.install.purgeWarning",
  "config.extensions.install.source",
  "config.extensions.install.unverified",
  "config.extensions.install.serverWarning",
  "config.extensions.install.permissions",
  "config.extensions.install.permissionsAdded",
  "config.extensions.install.permissionsRemoved",
  "config.extensions.install.none",
  "config.extensions.install.contributes",
  "config.extensions.install.fileViewers",
  "config.extensions.install.toolRenderers",
  "config.extensions.install.commands",
  "config.extensions.install.panels",
  "config.extensions.install.settings",
  "config.extensions.install.upgrade",
  "config.extensions.install.downgrade",
  "config.extensions.install.sameVersion",
  "config.extensions.install.committed",
  "config.extensions.install.cancelled",
  "config.extensions.install.unknown",
  "config.extensions.install.syncPending",
  "config.extensions.install.cleanupPending",
  "config.extensions.install.status",
  "config.extensions.install.statusFailed",
  "config.extensions.install.removePending",
  "config.extensions.install.removeSuccess",
  "config.extensions.install.removeFailed",
  "config.extensions.install.removeIncomplete",
  "config.extensions.install.removeUnknown",
  "config.extensions.install.removeConnectionChanged",
  "config.extensions.install.retry",
  "config.extensions.install.local",
  "config.extensions.install.localArchive",
  "config.extensions.install.archiveTrust",
  "config.extensions.install.localDigestComputed",
  "config.extensions.install.localDigestMatch",
  "config.extensions.install.localDigestMismatch",
  "config.extensions.install.localDigestPending",
  "config.extensions.install.localDropHint",
  "config.extensions.install.diagAlreadyInstalled",
  "config.extensions.install.diagNotInstalled",
  "config.extensions.install.diagDevLink",
  "config.extensions.install.diagRestart",
  "config.extensions.install.diagArchiveDns",
  "config.extensions.install.diagArchiveSha",
  "config.extensions.install.diagArchiveNetwork",
  "config.extensions.install.diagArchiveDigest",
  "config.extensions.install.diagArchiveSize",
  "config.extensions.install.diagServerChanged",
  "config.extensions.install.diagDescriptorJson",
  "config.extensions.install.diagDescriptorSchema",
  "config.extensions.install.diagDescriptorSize",
  "config.extensions.install.diagDescriptorNetwork",
  "config.extensions.install.releaseHint",
] as const
export type InstallationTranslationKey = (typeof installationTranslationKeys)[number]
export type InstallationLanguage = { t: (key: InstallationTranslationKey) => string }
