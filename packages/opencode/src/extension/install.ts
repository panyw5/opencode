import path from "node:path"
import { constants } from "node:fs"
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises"
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import semver from "semver"
import * as Registry from "./registry"
import { inlineIsolationWarning, load, type Loaded } from "./manifest"
import { ID_PATTERN, type ExtensionID, type RegistryRow, type OperationReceipt, type Source } from "./schema"
import { extensionPaths, generationPath, privateDirectory, canonicalRegistryFile } from "./paths"
import { ExtensionLeases } from "./leases"
import { generationOwnership, operationOwnership } from "./cleanup"
import { archiveLimits, extractArchive } from "./archive"
import {
  ArchiveDownloadError,
  downloadArchive,
  downloadPackage,
  readLocalArchive,
  requestJson,
  type DownloadOptions,
} from "./download"
import { Log } from "@opencode-ai/core/util/log"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { resolveNpm, materializeNpm, validateNpmRoot, type PreparedNpm } from "./npm"
import { normalizeReleaseUrl, parseReleaseDescriptor, releaseCompatible, resolveRelease } from "./release"
import { MAX_DESCRIPTOR_BYTES, MAX_SIGNATURE_BYTES, isSha256Hex } from "@opencode-ai/util/extension-release"
import {
  SignatureError,
  TRUSTED_KEYS,
  trustedKeysFor,
  verifyDescriptorSignature,
  type TrustedKey,
} from "./trust"

const log = Log.create({ service: "extension" })
const TTL = 10 * 60 * 1000
const MAX_OPERATIONS = 4
const TIMEOUT = 120_000

export type InstallSource =
  | { type: "npm"; spec: string }
  | { type: "archive"; url: string; sha256?: string }
  | { type: "local"; path: string; sha256?: string }
  | { type: "release"; url: string }
export type StagedRelease = { url: string; descriptor: string; path: string; signature?: string }
export type InstallRequest =
  | { kind: "install"; source: InstallSource }
  | { kind: "update"; id: string; source: InstallSource; version?: never; target?: never }
  | { kind: "update"; id: string; version: string; source?: never; target?: never }
  | { kind: "update"; id: string; target: "release-current"; source?: never; version?: never }
  | { kind: "uninstall"; id: string; purgeData?: boolean }

export type InstallPreview = {
  operationId: string
  expiresAt: number
  kind: InstallRequest["kind"]
  id: ExtensionID
  name: string
  oldVersion?: string
  version: string
  /** Explicit updates may reinstall the same version or downgrade; confirmation must display this distinction. */
  versionChange?: "upgrade" | "same-version" | "downgrade"
  sameVersion?: boolean
  downgrade?: boolean
  permissions: string[]
  permissionsAdded: string[]
  permissionsRemoved: string[]
  contributes: Loaded["contributes"]
  source: Source
  /** Release sources only: whether the descriptor signature verified against the pinned trust list. */
  signatureStatus?: "verified" | "unsigned"
  /** Last accepted publisher sequence; release-current updates must never move it backwards. */
  releaseSequence?: number
  expectedRevision?: number
  expectedRegistryVersion?: number
  registryUpgrade?: { from: 2; to: 3 }
  hasServer: boolean
  /** Stable warning codes carried over from the approved manifest plus source-derived ones (e.g. `server.isolation:inline`). */
  warnings?: string[]
  enable: boolean
  installId?: string
}
export type InstallResult = {
  operationId: string
  kind: InstallRequest["kind"]
  id: ExtensionID
  installId?: string
  state: "committed" | "cancelled" | "expired" | "failed" | "unknown"
  committed: boolean | undefined
  synced: boolean
  cleanupPending: boolean
  warnings: string[]
}
export type CoordinationInput = {
  operationId: string
  kind: InstallRequest["kind"]
  id: ExtensionID
  previous?: RegistryRow
  row?: RegistryRow
  purgeData: boolean
  receipt: OperationReceipt
}
export type InstallerOptions = {
  /** All managed paths are derived from this registry file, never a request-controlled root. */
  registry?: string
  download?: (input: DownloadOptions & ({ sha256?: string } | { integrity: string })) => Promise<Uint8Array>
  readLocal?: typeof readLocalArchive
  resolveNpm?: typeof resolveNpm
  resolveRelease?: typeof resolveRelease
  /** Trusted descriptor-signing key injection; requests never select verification keys. */
  trustedKeys?: readonly TrustedKey[]
  /** Host version for descriptor engines.opencode gating; defaults to the running installation. */
  opencodeVersion?: string
  materializeNpm?: typeof materializeNpm
  extract?: typeof extractArchive
  now?: () => number
  /** Trusted host dependency injection; requests never select a lease provider. */
  leases?: Pick<typeof ExtensionLeases, "acquireOperation" | "acquire">
  /** Acquire a lifecycle fence after materialization, before CAS. Release follows coordination and cleanup. */
  beforeCoordinate?: (input: Pick<CoordinationInput, "id" | "previous" | "kind">) => Promise<() => void | Promise<void>>
  coordinate?: (input: CoordinationInput) => Promise<{
    synced: boolean
    cleanupPending?: boolean
    warnings?: string[]
  }>
}

export class InstallError extends Error {
  override readonly name = "ExtensionInstallError"
  constructor(
    readonly code:
      | "invalid"
      | "unauthorized"
      | "busy"
      | "expired"
      | "conflict"
      | "failed"
      | "signature_invalid"
      | "rollback_detected",
    message: string,
  ) {
    super(message)
  }
}

/** Curated, whitelisted by the app: an interrupted process left a lease gate behind. */
export const LOCKED_MESSAGE = "Extension storage is locked by an interrupted process; unlock it to continue"
function gateLocked(error: unknown) {
  return error instanceof ExtensionLeases.LeaseError && error.gate !== undefined
    ? new InstallError("busy", LOCKED_MESSAGE)
    : undefined
}

type Owned = { directory: string; dev: number; ino: number }
type Operation = {
  id: string
  tokenHash: Buffer
  createdAt: number
  expiresAt: number
  kind: InstallRequest["kind"]
  operationLease?: ExtensionLeases.Lease
  generationLease?: ExtensionLeases.Lease
  stage?: Owned
  generation?: Owned
  previous?: RegistryRow
  retainedRevision?: number
  purgeData: boolean
  manifest?: Loaded
  npm?: PreparedNpm
  fingerprint?: string
  tree?: string
  preview?: InstallPreview
  result?: InstallResult
}

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const tokenDigest = (id: string, token: string) => createHash("sha256").update(`${id}\0${token}`).digest()
const clone = <T>(value: T): T => structuredClone(value)
function invalid(message = "Invalid extension operation"): never {
  throw new InstallError("invalid", message)
}
function extensionID(value: unknown): ExtensionID {
  if (typeof value !== "string" || value.length > 64 || !ID_PATTERN.test(value)) invalid("Invalid extension id")
  return value as ExtensionID
}
function same(actual: Buffer, expected: Buffer) {
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
function authenticate(id: string, token: string, expected: Buffer) {
  if (typeof token !== "string" || token.length > 256 || !same(tokenDigest(id, token), expected)) {
    throw new InstallError("unauthorized", "Invalid extension operation capability")
  }
}
function fingerprint(manifest: Loaded) {
  const { dir: _dir, webRoot: _root, ...content } = manifest
  return hash(JSON.stringify(content))
}
function publicSource(
  source: InstallSource,
  npm?: PreparedNpm,
  release?: Awaited<ReturnType<typeof resolveRelease>>,
): Source {
  if (source.type === "release") {
    if (!release) invalid()
    const artifact = new URL(release.artifact.url)
    artifact.search = ""
    artifact.hash = ""
    return {
      type: "release",
      descriptor: release.descriptor,
      extensionID: extensionID(release.id),
      version: release.version,
      artifact: artifact.href,
      sha256: release.artifact.sha256,
      descriptorSha256: release.descriptorSha256,
    }
  }
  if (source.type === "npm") {
    if (!npm) invalid()
    return { type: "npm", spec: `${npm.name}@${npm.version}`, registry: npm.registry, integrity: npm.integrity }
  }
  if (!source.sha256) invalid("Archive digest was not computed")
  if (source.type === "local") return { type: "archive", location: path.resolve(source.path), sha256: source.sha256 }
  const url = new URL(source.url)
  url.search = ""
  url.hash = ""
  return { type: "archive", location: url.href, sha256: source.sha256 }
}
function requestSource(value: unknown): InstallSource {
  if (!value || typeof value !== "object") invalid()
  const source = value as Record<string, unknown>
  if (source.type === "npm") {
    if (typeof source.spec !== "string" || !source.spec || source.spec.length > 1024) invalid("Invalid npm spec")
    return { type: "npm", spec: source.spec }
  }
  if (source.type === "release") {
    if (typeof source.url !== "string") invalid("Invalid release descriptor URL")
    try {
      return { type: "release", url: normalizeReleaseUrl(source.url) }
    } catch {
      invalid("Invalid release descriptor URL")
    }
  }
  if (source.type !== "archive" && source.type !== "local") invalid("Unsupported extension source")
  if (source.sha256 !== undefined && !isSha256Hex(source.sha256)) invalid("Invalid archive SHA-256")
  const digest = typeof source.sha256 === "string" ? source.sha256.toLowerCase() : undefined
  if (source.type === "local") {
    if (typeof source.path !== "string" || !path.isAbsolute(source.path) || source.path.includes("\0"))
      invalid("Invalid local archive path")
    return { type: "local", path: source.path, ...(digest === undefined ? {} : { sha256: digest }) }
  }
  if (typeof source.url !== "string" || source.url.length > 16384 || /[\s\\\x00-\x1f\x7f]/.test(source.url))
    invalid("Invalid archive URL")
  const url = URL.parse(source.url)
  if (!url || !/^https:\/\//i.test(source.url) || url.protocol !== "https:" || url.username || url.password)
    invalid("HTTPS archive URL without credentials required")
  return { type: "archive", url: source.url, ...(digest === undefined ? {} : { sha256: digest }) }
}

async function owned(directory: string): Promise<Owned> {
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
    throw new Error("Unsafe operation directory")
  return { directory, dev: stat.dev, ino: stat.ino }
}
async function removeOwned(value: Owned | undefined) {
  if (!value) return
  const stat = await lstat(value.directory).catch(() => undefined)
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== value.dev || stat.ino !== value.ino) return
  if ((await realpath(value.directory)) !== value.directory) return
  await rm(value.directory, { recursive: true, force: true })
}

/** SHA-256 of every path and byte, including files not referenced by the manifest. Never follows links. */
async function treeDigest(directory: string, signal?: AbortSignal, skipDependencies = false) {
  const digest = createHash("sha256")
  let count = 0
  let bytes = 0
  async function visit(dir: string) {
    const entries = (await readdir(dir)).sort()
    for (const name of entries) {
      signal?.throwIfAborted()
      if (skipDependencies && name === "node_modules") continue
      const file = path.join(dir, name)
      const stat = await lstat(file)
      if (++count > 50_000) throw new Error("Generation entry limit exceeded")
      digest.update(JSON.stringify(path.relative(directory, file))).update("\0")
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        digest.update("directory\0")
        await visit(file)
        continue
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > archiveLimits.fileBytes)
        throw new Error("Unsafe generation file")
      bytes += stat.size
      if (bytes > archiveLimits.inflatedBytes) throw new Error("Generation byte limit exceeded")
      digest.update(`file:${stat.size}\0`)
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const current = await handle.stat()
        if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size)
          throw new Error("Generation changed")
        let read = 0
        const chunk = Buffer.alloc(64 * 1024)
        while (true) {
          signal?.throwIfAborted()
          const result = await handle.read(chunk, 0, chunk.length, null)
          if (!result.bytesRead) break
          read += result.bytesRead
          if (read > stat.size) throw new Error("Generation changed")
          digest.update(chunk.subarray(0, result.bytesRead))
        }
        const after = await handle.stat()
        if (read !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
          throw new Error("Generation changed")
      } finally {
        await handle.close()
      }
      digest.update("\0")
    }
  }
  await owned(directory)
  await visit(directory)
  return digest.digest("hex")
}

/** Capabilities/prepared npm graph are intentionally process-local. Only durable committed receipts survive restart. */
export function createInstaller(options: InstallerOptions = {}) {
  const target = canonicalRegistryFile(options.registry ?? Registry.registryFile())
  const paths = extensionPaths(target)
  const now = options.now ?? Date.now
  const epoch = randomBytes(32)
  const operations = new Map<string, Operation>()
  const locks = new Map<string, Promise<unknown>>()
  let preparing = 0
  const extract = options.extract ?? extractArchive
  const leases = options.leases ?? ExtensionLeases
  let closed = false
  async function releaseLease(op: Operation, key: "operationLease" | "generationLease") {
    const lease = op[key]
    if (!lease) return
    await lease.release()
    delete op[key]
  }
  async function finishOperation(op: Operation) {
    try {
      await removeOwned(op.stage)
    } catch {
      if (op.result) op.result.cleanupPending = true
    }
    try {
      await releaseLease(op, "operationLease")
    } catch {
      if (op.result) {
        op.result.cleanupPending = true
        op.result.warnings.push("Operation lease release failed; cleanup is pending")
      }
    }
  }

  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(id) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(fn)
    locks.set(id, result)
    void result
      .finally(() => {
        if (locks.get(id) === result) locks.delete(id)
      })
      .catch(() => {})
    return result
  }
  async function record(op: Operation, state: string) {
    if (!op.stage) return
    // No capability, URL query, settings or arbitrary exception payload is written here.
    const metadata = {
      operationId: op.id,
      kind: op.kind,
      expiresAt: op.expiresAt,
      state,
      tokenHash: op.tokenHash.toString("hex"),
      preview: op.preview,
      fingerprint: op.fingerprint,
      tree: op.tree,
    }
    const temp = path.join(op.stage.directory, `.record-${randomUUID()}`)
    await writeFile(temp, JSON.stringify(metadata), { flag: "wx", mode: 0o600 })
    await rename(temp, path.join(op.stage.directory, "operation.json"))
    await writeFile(path.join(op.stage.directory, "journal.jsonl"), `${JSON.stringify({ state, at: now() })}\n`, {
      flag: "a",
      mode: 0o600,
    })
  }
  function terminal(op: Operation, state: "cancelled" | "expired" | "failed"): InstallResult {
    return {
      operationId: op.id,
      kind: op.kind,
      id: op.preview!.id,
      installId: op.preview!.installId,
      state,
      committed: false,
      synced: false,
      cleanupPending: false,
      warnings: [],
    }
  }
  function fromReceipt(receipt: OperationReceipt): InstallResult {
    return {
      operationId: receipt.id,
      kind: receipt.kind,
      id: receipt.extensionID,
      installId: receipt.installId,
      state: "committed",
      committed: true,
      synced: false,
      cleanupPending: receipt.cleanupPending,
      warnings: ["Durable commit recovered; runtime synchronization has not been confirmed in this process"],
    }
  }
  async function recovered(id: string, token: string) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
      throw new InstallError("unauthorized", "Invalid extension operation capability")
    const receipt = await Registry.receipt(id, target)
    // Always hash a supplied token, including a miss, before reporting the same authorization error.
    authenticate(id, token, receipt ? Buffer.from(receipt.tokenHash, "hex") : Buffer.alloc(32))
    if (!receipt) throw new InstallError("unauthorized", "Invalid extension operation capability")
    return fromReceipt(receipt)
  }
  async function expire(op: Operation) {
    if (op.result || now() < op.expiresAt) return
    op.result = terminal(op, "expired")
    await finishOperation(op)
  }
  async function sweep() {
    for (const op of operations.values()) {
      if (locks.has(op.id)) continue
      await locked(op.id, async () => {
        if (op.preview) await expire(op)
        if (op.result && now() > op.expiresAt + TTL) operations.delete(op.id)
      })
    }
  }
  async function capability(id: string, token: string) {
    const op = operations.get(id)
    if (!op) return
    authenticate(id, token, op.tokenHash)
    await expire(op)
    return op
  }

  async function prepare(
    request: InstallRequest,
    stagedRelease?: StagedRelease,
    stagedArchive?: { path: string },
  ): Promise<InstallPreview & { token: string }> {
    if (!request || typeof request !== "object" || !["install", "update", "uninstall"].includes(request.kind)) invalid()
    if (
      stagedArchive &&
      (request.kind === "uninstall" ||
        !("source" in request) ||
        request.source?.type !== "archive" ||
        typeof stagedArchive.path !== "string" ||
        !path.isAbsolute(stagedArchive.path))
    )
      invalid("Invalid staged archive request")
    if (stagedRelease) {
      if (
        request.kind === "uninstall" ||
        (request.kind === "install" && request.source?.type !== "release") ||
        (request.kind === "update" && request.target !== "release-current")
      )
        invalid("Invalid staged release request")
      if (
        typeof stagedRelease.descriptor === "string" &&
        Buffer.byteLength(stagedRelease.descriptor, "utf8") > MAX_DESCRIPTOR_BYTES
      )
        invalid("Release descriptor exceeds the 64 KiB download limit")
      if (
        typeof stagedRelease.descriptor !== "string" ||
        typeof stagedRelease.path !== "string" ||
        !path.isAbsolute(stagedRelease.path)
      )
        invalid("Invalid staged release request")
      if (
        stagedRelease.signature !== undefined &&
        (typeof stagedRelease.signature !== "string" ||
          Buffer.byteLength(stagedRelease.signature, "utf8") > MAX_SIGNATURE_BYTES)
      )
        invalid("Invalid staged release signature")
    }
    if (closed) throw new InstallError("conflict", "Extension installer is closed")
    if (request.kind === "update" && ["source", "version", "target"].filter((key) => key in request).length !== 1)
      invalid("Choose one update target")
    await sweep()
    if (preparing + [...operations.values()].filter((op) => op.preview && !op.result).length >= MAX_OPERATIONS) {
      throw new InstallError("busy", "Too many pending extension operations")
    }
    preparing++
    const id = randomUUID()
    const binding = hash(
      JSON.stringify({
        request,
        ...(stagedRelease
          ? { release: { url: stagedRelease.url, descriptorSha256: hash(stagedRelease.descriptor) } }
          : {}),
      }),
    )
    const nonce = randomBytes(32).toString("hex")
    let token = `${nonce}.${createHmac("sha256", epoch).update(`${id}\0${binding}\0${nonce}`).digest("hex")}`
    const op: Operation = {
      id,
      tokenHash: tokenDigest(id, token),
      createdAt: now(),
      expiresAt: now() + TTL,
      kind: request.kind,
      purgeData: false,
    }
    operations.set(id, op)
    try {
      return await locked(id, async () => {
        await privateDirectory(paths.root)
        await privateDirectory(paths.staging)
        const stage = path.join(paths.staging, id)
        op.operationLease = await leases.acquireOperation(target, id)
        await mkdir(stage, { mode: 0o700 })
        op.stage = await owned(stage)
        await writeFile(
          path.join(stage, "ownership.json"),
          JSON.stringify(
            operationOwnership(target, {
              operationId: id,
              createdAt: op.createdAt,
            }),
          ),
          { flag: "wx", mode: 0o600 },
        )
        const signal = AbortSignal.timeout(TIMEOUT)
        log.info("prepare started", {
          kind: request.kind,
          sourceType: "source" in request ? request.source?.type : undefined,
        })
        let source: InstallSource | undefined
        let previous: RegistryRow | undefined
        let old: Loaded | undefined
        let expectedID: ExtensionID | undefined
        let registryVersion: number | undefined
        if (request.kind !== "install") {
          expectedID = extensionID(request.id)
          const snapshot = await Registry.snapshot(expectedID, target)
          registryVersion = snapshot.registryVersion
          if (!snapshot.row) throw new InstallError("conflict", "Extension is not installed")
          previous = snapshot.row
          op.previous = previous
          // Uninstall must still work for an unreadable/broken package; no code is imported.
          old = await load(previous.dir).catch(() => undefined)
          if (request.kind === "update" && previous.source.type === "path")
            throw new InstallError("conflict", "Development links cannot be updated by the installer")
        }
        if (request.kind === "uninstall") {
          if (request.purgeData !== undefined && typeof request.purgeData !== "boolean") invalid("Invalid purge option")
          op.purgeData = request.purgeData ?? false
          op.preview = {
            operationId: id,
            expiresAt: op.expiresAt,
            kind: request.kind,
            id: expectedID!,
            name: previous!.name,
            oldVersion: previous!.version,
            version: previous!.version,
            permissions: [],
            permissionsAdded: [],
            permissionsRemoved: old?.permissions ?? [],
            contributes: {},
            source: previous!.source,
            expectedRevision: previous!.revision ?? 0,
            expectedRegistryVersion: registryVersion,
            hasServer: !!old?.serverEntry,
            enable: false,
            installId: previous!.installId,
          }
        } else {
          if (request.kind === "update" && request.target !== undefined) {
            if (request.target !== "release-current" || previous!.source.type !== "release")
              invalid("A release update requires an installed release source")
            source = requestSource({ type: "release", url: previous!.source.descriptor })
          } else if (request.kind === "update" && !request.source) {
            if (
              previous!.source.type !== "npm" ||
              typeof request.version !== "string" ||
              !semver.valid(request.version)
            )
              invalid("A valid npm update version or explicit source is required")
            source = { type: "npm", spec: `${previous!.name}@${request.version}` }
          } else source = requestSource(request.source)
          let input: Uint8Array
          let release: Awaited<ReturnType<typeof resolveRelease>> | undefined
          if (source.type === "release") {
            if (stagedRelease) {
              if (normalizeReleaseUrl(stagedRelease.url) !== source.url) invalid("Release descriptor source mismatch")
              let descriptor: ReturnType<typeof parseReleaseDescriptor>
              try {
                descriptor = parseReleaseDescriptor(JSON.parse(stagedRelease.descriptor))
              } catch {
                invalid("Release descriptor does not match schema version 1")
              }
              release = { ...descriptor, descriptor: source.url, descriptorSha256: hash(stagedRelease.descriptor) }
              // A staged descriptor under a trusted origin must verify against
              // the same detached signature the online resolver enforces.
              const trusted = trustedKeysFor(source.url, options.trustedKeys ?? TRUSTED_KEYS)
              if (trusted.length) {
                if (typeof stagedRelease.signature !== "string")
                  throw new InstallError(
                    "signature_invalid",
                    "Release descriptor signature is required for this source",
                  )
                const verified = verifyDescriptorSignature({
                  url: source.url,
                  descriptor: Buffer.from(stagedRelease.descriptor, "utf8"),
                  document: stagedRelease.signature,
                  keys: trusted,
                })
                release.signature = verified
                log.info("release signature verified", { kind: request.kind, keyId: verified?.keyId })
              }
              if (!releaseCompatible(release, options.opencodeVersion ?? InstallationVersion))
                invalid("Extension is not compatible with this OpenCode version")
              input = await (options.readLocal ?? readLocalArchive)({
                file: stagedRelease.path,
                sha256: descriptor.artifact.sha256,
                signal,
              })
              log.info("staged release verified", {
                kind: request.kind,
                extensionID: release.id,
                version: release.version,
              })
            } else {
              release = await (options.resolveRelease ?? resolveRelease)(source.url, {
                signal,
                trustedKeys: options.trustedKeys,
              })
              // Descriptor declared engines.opencode gate: reject before the artifact download.
              if (!releaseCompatible(release, options.opencodeVersion ?? InstallationVersion))
                invalid("Extension is not compatible with this OpenCode version")
              input = await (options.download ?? downloadArchive)({
                url: release.artifact.url,
                sha256: release.artifact.sha256,
                signal,
              })
            }
            // The publisher sequence is signed inside the descriptor; a
            // release-current update may never move it backwards. An identical
            // sequence is idempotent and explicit-source previews are unaffected.
            if (
              request.kind === "update" &&
              request.target === "release-current" &&
              release.sequence !== undefined &&
              previous!.releaseSequence !== undefined &&
              release.sequence < previous!.releaseSequence
            )
              throw new InstallError(
                "rollback_detected",
                "The published release moved backwards; refusing a rolled-back descriptor",
              )
          } else if (source.type === "npm") {
            op.npm = await (options.resolveNpm ?? resolveNpm)(source.spec, {
              transport: requestJson,
              signal,
              registry: previous?.source.type === "npm" ? previous.source.registry : undefined,
            })
            input = await (options.download ?? downloadPackage)({
              url: op.npm.tarball,
              integrity: op.npm.integrity,
              signal,
            })
          } else if (source.type === "local") {
            input = await (options.readLocal ?? readLocalArchive)({ file: source.path, sha256: source.sha256, signal })
          } else if (stagedArchive) {
            input = await (options.readLocal ?? readLocalArchive)({
              file: stagedArchive.path,
              sha256: source.sha256,
              signal,
            })
          } else input = await (options.download ?? downloadArchive)({ url: source.url, sha256: source.sha256, signal })
          signal.throwIfAborted()
          log.info("archive received", { kind: request.kind, sourceType: source.type, bytes: input.byteLength })
          if (!(input instanceof Uint8Array) || input.byteLength > archiveLimits.compressedBytes)
            invalid("Archive compressed size limit exceeded")
          const expectedDigest =
            source.type === "release" ? release!.artifact.sha256 : source.type === "npm" ? undefined : source.sha256
          const actualDigest = hash(input)
          if (expectedDigest && actualDigest !== expectedDigest) invalid("Archive integrity mismatch")
          if (source.type === "archive" || source.type === "local") {
            log.info("archive digest pinned", { sourceType: source.type, expectedDigestProvided: !!expectedDigest })
            source = { ...source, sha256: actualDigest }
          }
          const candidate = path.join(stage, "package")
          await extract({ input, directory: candidate, signal, policy: source.type === "npm" ? "npm" : "archive" })
          if (op.npm) await validateNpmRoot(op.npm, candidate, signal)
          op.manifest = await load(candidate, { opencodeVersion: options.opencodeVersion })
          const manifest = op.manifest
          if (op.npm && (manifest.name !== op.npm.name || manifest.version !== op.npm.version))
            invalid("npm candidate identity mismatch")
          if (release && (manifest.id !== release.id || manifest.version !== release.version))
            invalid("Release candidate identity mismatch")
          if (request.kind === "update") {
            if (manifest.id !== expectedID || manifest.name !== previous!.name)
              throw new InstallError("conflict", "Update must retain the installed extension identity")
          }
          const snapshot = await Registry.snapshot(manifest.id, target)
          if (request.kind === "install" && snapshot.row)
            throw new InstallError("conflict", "Extension is already installed")
          if (request.kind === "update" && snapshot.row?.revision !== previous!.revision)
            throw new InstallError("conflict", "Extension changed during preparation")
          if (registryVersion !== undefined && snapshot.registryVersion !== registryVersion)
            throw new InstallError("conflict", "Registry format changed during preparation")
          registryVersion = snapshot.registryVersion
          op.retainedRevision = snapshot.retained?.revision
          op.fingerprint = fingerprint(manifest)
          op.tree = await treeDigest(candidate, signal)
          const permissions = manifest.permissions
          const before = old?.permissions ?? []
          const pub = publicSource(source, op.npm, release)
          // Managed sources (never `path` here) may still declare `inline` —
          // the declaration is advisory, never silently dropped (design §7).
          const warnings = [...manifest.warnings]
          const isolation = inlineIsolationWarning(pub.type, manifest)
          if (isolation) {
            warnings.push(isolation)
            log.warn("extension declares inline isolation outside a path install", {
              extension: manifest.id,
              source: pub.type,
            })
          }
          op.preview = {
            operationId: id,
            expiresAt: op.expiresAt,
            kind: request.kind,
            id: manifest.id,
            name: manifest.name,
            oldVersion: previous?.version,
            version: manifest.version,
            ...(request.kind === "update"
              ? {
                  versionChange: semver.gt(manifest.version, previous!.version)
                    ? ("upgrade" as const)
                    : semver.lt(manifest.version, previous!.version)
                      ? ("downgrade" as const)
                      : ("same-version" as const),
                  sameVersion: semver.eq(manifest.version, previous!.version),
                  downgrade: semver.lt(manifest.version, previous!.version),
                }
              : {}),
            permissions,
            permissionsAdded: permissions.filter((permission) => !before.includes(permission)),
            permissionsRemoved: before.filter((permission) => !permissions.includes(permission)),
            contributes: manifest.contributes,
            source: pub,
            ...(warnings.length ? { warnings } : {}),
            ...(release
              ? { signatureStatus: release.signature ? ("verified" as const) : ("unsigned" as const) }
              : {}),
            ...((release?.sequence ?? previous?.releaseSequence) === undefined
              ? {}
              : { releaseSequence: release?.sequence ?? previous?.releaseSequence }),
            expectedRevision: previous ? (previous.revision ?? 0) : undefined,
            expectedRegistryVersion: registryVersion,
            ...(release && registryVersion === 2 ? { registryUpgrade: { from: 2 as const, to: 3 as const } } : {}),
            hasServer: !!manifest.serverEntry,
            enable: previous?.enabled ?? false,
            installId: randomUUID(),
          }
        }
        signal.throwIfAborted()
        if (now() >= op.expiresAt) throw new InstallError("expired", "Extension preparation expired")
        // Bind the granted capability to the final identity, row/tombstone revision and full approved content.
        token = `${nonce}.${createHmac("sha256", epoch)
          .update(
            JSON.stringify({
              id,
              binding,
              nonce,
              preview: op.preview,
              retainedRevision: op.retainedRevision,
              fingerprint: op.fingerprint,
              tree: op.tree,
            }),
          )
          .digest("hex")}`
        op.tokenHash = tokenDigest(id, token)
        await record(op, "prepared")
        log.info("preview prepared", { kind: op.kind, extensionID: op.preview!.id, version: op.preview!.version })
        return { ...clone(op.preview!), token }
      })
    } catch (error) {
      // Never log raw transport errors, request URLs, paths or capabilities.
      log.warn("prepare failed", {
        kind: request.kind,
        category:
          error instanceof ArchiveDownloadError
            ? "download"
            : error instanceof SignatureError
              ? "signature"
              : error instanceof InstallError
                ? "installation"
                : "internal",
        code: error instanceof ArchiveDownloadError || error instanceof InstallError ? error.code : "unknown",
      })
      operations.delete(id)
      await finishOperation(op)
      if (error instanceof InstallError) throw error
      const gate = gateLocked(error)
      if (gate) throw gate
      if (error instanceof SignatureError)
        throw new InstallError("signature_invalid", "Release descriptor signature verification failed")
      if (error instanceof ArchiveDownloadError) {
        const message =
          error.code === "address"
            ? "Archive download blocked by non-public DNS (proxy/fake-IP). Use desktop archive download or a local .tgz file."
            : error.code === "integrity"
              ? "Archive SHA-256 verification failed; no extension was installed"
              : "Archive download failed; check the network/proxy or use a local .tgz file"
        throw new InstallError("failed", message)
      }
      throw new InstallError("failed", "Extension preparation failed; no extension was installed")
    } finally {
      preparing--
    }
  }

  async function commit(
    operationId: string,
    token: string,
    input: { enable?: boolean; acceptRegistryUpgrade?: boolean } = {},
  ): Promise<InstallResult> {
    return locked(operationId, async () => {
      const op = await capability(operationId, token)
      if (!op) return recovered(operationId, token)
      await durableResult(op)
      if (op.result) return clone(op.result)
      if (!op.preview || !op.stage) throw new InstallError("conflict", "Operation is not prepared")
      if (input.enable !== undefined && typeof input.enable !== "boolean") invalid("Invalid enable option")
      if (input.acceptRegistryUpgrade !== undefined && typeof input.acceptRegistryUpgrade !== "boolean")
        invalid("Invalid registry upgrade confirmation")
      const preview = op.preview
      log.info("commit started", { kind: op.kind, extensionID: preview.id, version: preview.version })
      if (preview.registryUpgrade && input.acceptRegistryUpgrade !== true)
        throw new InstallError("conflict", "Registry format upgrade requires explicit confirmation")
      const receipt: OperationReceipt = {
        id: op.id,
        kind: op.kind,
        extensionID: preview.id,
        tokenHash: op.tokenHash.toString("hex"),
        committedAt: now(),
        installId: preview.installId,
        cleanupPending: true,
        purgeData: op.purgeData,
        previousInstallId: op.previous?.installId,
      }
      let release: (() => void | Promise<void>) | undefined
      try {
        let committed = false
        let next: RegistryRow | undefined
        try {
          if (now() >= op.expiresAt) throw new InstallError("expired", "Extension operation expired")
          const snapshot = await Registry.snapshot(preview.id, target)
          // Purge-aware: a tombstone consumed by its own cleanup is safe to proceed.
          if (
            snapshot.registryVersion !== preview.expectedRegistryVersion ||
            (snapshot.row ? (snapshot.row.revision ?? 0) : undefined) !== preview.expectedRevision ||
            (!snapshot.row && snapshot.retained && snapshot.retained.revision !== op.retainedRevision)
          )
            throw new InstallError("conflict", "Extension changed; prepare the operation again")
          await record(op, "committing")
          if (op.kind !== "uninstall") {
            const signal = AbortSignal.timeout(TIMEOUT)
            const candidate = path.join(op.stage.directory, "package")
            if (
              (await treeDigest(candidate, signal)) !== op.tree ||
              fingerprint(await load(candidate)) !== op.fingerprint
            )
              throw new InstallError("conflict", "Prepared extension content changed")
            await privateDirectory(paths.packages)
            const generation = generationPath(target, preview.installId!)
            op.generationLease = await leases.acquire(target, preview.installId!)
            await mkdir(generation, { mode: 0o700 })
            op.generation = await owned(generation)
            const directory = path.join(generation, "package")
            const writeOwnership = () =>
              writeFile(
                path.join(generation, "installation.json"),
                JSON.stringify(
                  generationOwnership(target, {
                    operationId: op.id,
                    installId: preview.installId!,
                    id: preview.id,
                    name: preview.name,
                    contentHash: op.tree!,
                    createdAt: op.createdAt,
                  }),
                ),
                { flag: "wx", mode: 0o600 },
              )
            if (op.npm) {
              await (options.materializeNpm ?? materializeNpm)(op.npm, {
                directory: generation,
                signal,
                download: options.download ?? downloadPackage,
                extract: (input, context) => extract({ input, ...context, policy: "npm" }),
              })
              await writeOwnership()
              if ((await treeDigest(directory, signal, true)) !== op.tree)
                throw new InstallError("conflict", "Materialized npm root differs from the approved candidate")
            } else {
              await writeOwnership()
              await cp(candidate, directory, { recursive: true, force: false, errorOnExist: true, dereference: false })
              if ((await treeDigest(directory, signal)) !== op.tree)
                throw new InstallError("conflict", "Copied extension differs from the approved candidate")
            }
            if (fingerprint(await load(directory)) !== op.fingerprint)
              throw new InstallError("conflict", "Extension manifest changed")
            signal.throwIfAborted()
            if (now() >= op.expiresAt) throw new InstallError("expired", "Extension operation expired")
            next = {
              name: preview.name,
              version: preview.version,
              source: preview.source,
              dir: directory,
              enabled: op.previous?.enabled ?? input.enable ?? false,
              installedAt: now(),
              installId: preview.installId,
              ...(preview.releaseSequence === undefined ? {} : { releaseSequence: preview.releaseSequence }),
            }
          }
          // Do not stop an existing runtime until candidate validation/materialization has succeeded.
          if (options.beforeCoordinate) {
            release = await options.beforeCoordinate({ id: preview.id, previous: clone(op.previous), kind: op.kind })
            if (typeof release !== "function") throw new Error("Lifecycle fence did not return a release callback")
          }
          if (now() >= op.expiresAt) throw new InstallError("expired", "Extension operation expired")
          const fenced = await Registry.snapshot(preview.id, target)
          if (
            fenced.registryVersion !== preview.expectedRegistryVersion ||
            (fenced.row ? (fenced.row.revision ?? 0) : undefined) !== preview.expectedRevision ||
            (!fenced.row && fenced.retained?.revision !== op.retainedRevision)
          )
            throw new InstallError("conflict", "Extension changed; prepare the operation again")
          if (op.kind === "uninstall") {
            // Data and generations are deliberately retained. A coordinator may later prove them safe to collect.
            await Registry.commitRemoval(
              {
                id: preview.id,
                expectedRevision: preview.expectedRevision!,
                expectedRegistryVersion: preview.expectedRegistryVersion,
                receipt,
                purgeData: false,
              },
              target,
            )
          } else {
            await Registry.commitInstallation(
              {
                id: preview.id,
                row: next!,
                expectedRevision: preview.expectedRevision,
                expectedRetainedRevision: op.retainedRevision,
                expectedRegistryVersion: preview.expectedRegistryVersion,
                acceptRegistryUpgrade: input.acceptRegistryUpgrade,
                receipt,
              },
              undefined,
              target,
            )
          }
          committed = true
          log.info("registry commit durable", { kind: op.kind, extensionID: preview.id, version: preview.version })
        } catch (error) {
          // A failed response is not proof that the atomic registry write did not persist.
          let durable: OperationReceipt | undefined
          try {
            durable = await Registry.receipt(operationId, target)
          } catch {
            op.result = {
              ...terminal(op, "failed"),
              state: "unknown",
              committed: undefined,
              cleanupPending: true,
              warnings: ["Commit outcome could not be read; managed files were preserved for reconciliation"],
            }
            return clone(op.result)
          }
          if (durable && same(Buffer.from(durable.tokenHash, "hex"), op.tokenHash)) committed = true
          if (!committed) {
            op.result = terminal(op, error instanceof InstallError && error.code === "expired" ? "expired" : "failed")
            await removeOwned(op.generation).catch(() => {
              op.result!.cleanupPending = true
            })
            await finishOperation(op)
            if (error instanceof InstallError) throw error
            const gate = gateLocked(error)
            if (gate) throw gate
            if (error instanceof Registry.ConflictError) throw new InstallError("conflict", error.message)
            if (error instanceof Registry.SettingsError) throw new InstallError("conflict", error.message)
            throw new InstallError("failed", "Extension commit failed; no registry change was confirmed")
          }
        }
        op.result = {
          operationId,
          kind: op.kind,
          id: preview.id,
          installId: preview.installId,
          state: "committed",
          committed: true,
          synced: false,
          cleanupPending: true,
          warnings: [],
        }
        try {
          // The row is re-read after CAS so inherited settings/enabled state remain authoritative.
          const row = op.kind === "uninstall" ? undefined : (await Registry.snapshot(preview.id, target)).row
          if (!options.coordinate)
            op.result.warnings.push("Runtime coordinator unavailable; synchronization and cleanup are deferred")
          else {
            const coordinated = await options.coordinate({
              operationId,
              kind: op.kind,
              id: preview.id,
              previous: clone(op.previous),
              row,
              purgeData: op.purgeData,
              receipt: clone(receipt),
            })
            op.result.synced = coordinated.synced === true
            op.result.cleanupPending = coordinated.cleanupPending !== false
            if (coordinated.warnings?.length) op.result.warnings.push("Runtime coordinator reported warnings")
            if (!op.result.synced) op.result.warnings.push("Runtime synchronization is pending")
          }
        } catch {
          op.result.warnings.push("Installation committed, but runtime synchronization failed")
        }
        if (op.purgeData && op.result.cleanupPending)
          op.result.warnings.push(
            "Data purge is deferred until safe lifecycle coordination; settings and data were retained",
          )
        log.info("runtime coordination finished", {
          kind: op.kind,
          extensionID: preview.id,
          synced: op.result.synced,
          cleanupPending: op.result.cleanupPending,
        })
        await record(op, "committed").catch(() => {
          op.result!.warnings.push("Commit persisted; operation journal update failed")
        })
        await finishOperation(op)
        return op.result
      } finally {
        try {
          await release?.()
        } catch {
          // A release failure must never erase a durable commit or pretend it rolled back.
          if (op.result) {
            op.result.synced = false
            op.result.cleanupPending = true
            op.result.warnings.push("Lifecycle fence release failed; reconciliation is pending")
          }
        }
        for (const key of ["generationLease", "operationLease"] as const) {
          try {
            await releaseLease(op, key)
          } catch {
            if (op.result) {
              op.result.cleanupPending = true
              op.result.warnings.push("Managed lease release failed; cleanup is pending")
            }
          }
        }
        if (op.result?.committed) {
          await Registry.updateCleanupReceipt(
            op.id,
            op.tokenHash.toString("hex"),
            op.result.cleanupPending,
            target,
          ).catch(() => {
            op.result!.cleanupPending = true
            op.result!.warnings.push("Cleanup receipt update failed; reconciliation is pending")
          })
        }
      }
    }).then(clone)
  }
  async function durableResult(op: Operation) {
    if (op.result?.state !== "unknown") return
    const receipt = await Registry.receipt(op.id, target).catch(() => undefined)
    if (receipt && same(Buffer.from(receipt.tokenHash, "hex"), op.tokenHash)) op.result = fromReceipt(receipt)
  }
  async function status(operationId: string, token: string) {
    return locked(operationId, async () => {
      const op = await capability(operationId, token)
      if (!op) return recovered(operationId, token)
      await durableResult(op)
      if (op.result) return clone(op.result)
      return { state: "prepared" as const, committed: false as const, ...clone(op.preview!) }
    })
  }
  async function cancel(operationId: string, token: string): Promise<InstallResult> {
    return locked(operationId, async () => {
      const op = await capability(operationId, token)
      if (!op) return recovered(operationId, token)
      await durableResult(op)
      if (op.result) return clone(op.result)
      op.result = terminal(op, "cancelled")
      await record(op, "cancelled").catch(() => {})
      await finishOperation(op)
      return clone(op.result)
    })
  }
  /** Release only this installer's pending capabilities; committed registry state is never reset. */
  async function close() {
    closed = true
    await Promise.all(
      [...operations.values()].map((op) =>
        locked(op.id, async () => {
          if (!op.result && op.preview) op.result = terminal(op, "cancelled")
          if (op.result?.state !== "unknown") await finishOperation(op)
          for (const key of ["generationLease", "operationLease"] as const) {
            await releaseLease(op, key).catch(() => {
              if (op.result) op.result.cleanupPending = true
            })
          }
        }),
      ),
    )
  }
  return {
    prepare: (request: InstallRequest) => prepare(request),
    // Only the desktop's private IPC bridge can supply staged release bytes.
    prepareRelease: (request: InstallRequest, release: StagedRelease) => prepare(request, release),
    prepareArchive: (request: InstallRequest, archive: { path: string }) => prepare(request, undefined, archive),
    commit,
    status,
    cancel,
    close,
    /** User-confirmed removal of gates abandoned by killed processes; live (recent) gates are kept. */
    unlock: async () => {
      const report = await ExtensionLeases.unlockStaleGates(target)
      log.info("stale lease gates unlocked", {
        removed: report.removed.join(",") || "none",
        recent: report.recent.join(",") || "none",
        untrusted: report.untrusted.join(",") || "none",
      })
      return report
    },
  }
}

export * as ExtensionInstall from "./install"
