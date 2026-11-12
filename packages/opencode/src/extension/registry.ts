import path from "node:path"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { ConfigParse } from "@/config/parse"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@opencode-ai/core/util/flock"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { load, CompatibilityError, type Loaded } from "./manifest"
import { publish, publishError } from "./event"
import { assertDevelopmentDirectory, canonicalRegistryFile, generationPath, ownedGeneration } from "./paths"
import {
  RegistryStore,
  ReleaseSource,
  type Contributes,
  type ExtensionID,
  type Info,
  type RegistryRow,
  type RetainedData,
  type OperationReceipt,
  type Source,
  type RegistryStore as VersionedStore,
} from "./schema"

// The decoded format is version-discriminated. A locked write transaction needs
// mutable rows while atomically moving from v2 to v3; writeStore revalidates the
// complete version/source pair before any bytes are written.
type Store = Omit<VersionedStore, "extensions" | "retained"> & {
  extensions: Record<ExtensionID, RegistryRow>
  retained?: Record<ExtensionID, RetainedData>
}

export class NotFoundError extends Error {
  override readonly name = "ExtensionNotFoundError"

  constructor(readonly id: ExtensionID) {
    super(`Extension not found: ${id}`)
  }
}

export class ConflictError extends Error {
  override readonly name = "ExtensionConflictError"
}

export class SettingsError extends Error {
  override readonly name = "ExtensionSettingsError"
}

/**
 * Placeholder returned in `Info.settings` for secret values. The plaintext
 * value only ever lives in the registry file; submitting the mask back through
 * `updateSettings` is treated as "keep the stored value".
 */
export const SECRET_MASK = "********"

type SettingDefinition = NonNullable<Contributes["settings"]>[string]

export function registryFile() {
  return canonicalRegistryFile(
    Flag.OPENCODE_EXTENSION_REGISTRY_FILE ?? path.join(Global.Path.data, "extensions", "registry.json"),
  )
}

const file = registryFile

function lock(target: string) {
  return `extension-registry:${target}`
}

function empty(): Store {
  return { version: 2, revision: 0, extensions: {}, receipts: {}, retained: {} }
}

async function readStore(target = file()): Promise<Store> {
  const text = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return empty()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`Extension registry is invalid JSON: ${target}`, { cause: error })
  }
  const store = ConfigParse.schema(RegistryStore, json, target)
  if (store.version === 1) {
    // All callers hold the registry flock. Keep the original bytes for an
    // explicit downgrade; never overwrite a previous migration backup.
    await writeFile(`${target}.v1.bak`, text, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    store.version = 2
    store.revision = 0
    store.receipts = {}
    store.retained = {}
    for (const row of Object.values(store.extensions)) row.revision = 0
    await writeStore(target, store)
  }
  return store
}

async function writeStore(target: string, store: Store) {
  Schema.decodeUnknownSync(RegistryStore)(store)
  await mkdir(path.dirname(target), { recursive: true })
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function nextRevision(store: Store) {
  store.revision = (store.revision ?? 0) + 1
  return store.revision
}

export function sourceIdentity(source: Source) {
  switch (source.type) {
    case "npm":
      return `npm:${source.registry}:${source.spec.replace(/@[^@/]+$/, "")}`
    case "archive":
      return `archive:${source.location}`
    case "path":
      return `path:${Filesystem.resolve(source.path)}`
    case "release":
      return `release:${JSON.stringify([source.descriptor, source.extensionID])}`
    default: {
      const unsupported: never = source
      throw new ConflictError("Unsupported extension source")
    }
  }
}

export function installedManifest(row: RegistryRow, manifest: Loaded): Loaded {
  if (!row.installId) return manifest
  if (manifest.name !== row.name || manifest.version !== row.version) {
    throw new ConflictError("Managed extension manifest identity changed")
  }
  return {
    ...manifest,
    versionSegment: `${manifest.versionSegment}-${row.installId}`,
    serverFingerprint: manifest.serverFingerprint ? `${manifest.serverFingerprint}-${row.installId}` : undefined,
  }
}

function asset(base: string, value: string | undefined) {
  if (!value) return
  return `${base.replace(/\/?$/, "/")}${value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`
}

/**
 * Build the user-facing settings view of a registry row: declared settings
 * resolve to their stored value or the manifest default, and `secret` values
 * are replaced with `SECRET_MASK`. Undeclared stored keys stay on disk for a
 * future manifest, but are never returned to clients because their secret
 * classification is unknown.
 */
function maskSettings(row: RegistryRow, manifest: Loaded): Record<string, unknown> {
  const definitions = manifest.contributes.settings ?? {}
  const stored = row.settings ?? {}
  const result: Record<string, unknown> = {}
  for (const [key, definition] of Object.entries(definitions)) {
    const value = key in stored ? stored[key] : definition.default
    // An unset (or empty) secret is reported as-is so the UI can tell
    // "configured" apart from "default/empty"; only real values are masked.
    result[key] = (definition.secret || row.secretKeys?.includes(key)) && value ? SECRET_MASK : value
  }
  return result
}

function info(row: RegistryRow, manifest: Loaded, base: string): Info {
  const enabled = row.enabled
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    icon: asset(base, manifest.icon),
    source: row.source,
    revision: row.revision ?? 0,
    installId: row.installId,
    enabled,
    state: enabled ? "ready" : "disabled",
    activation: manifest.activation,
    contributes: manifest.contributes,
    permissions: manifest.permissions,
    ...(manifest.warnings.length ? { warnings: manifest.warnings } : {}),
    settings: maskSettings(row, manifest),
    ...(manifest.entry
      ? {
          web: {
            base,
            entry: manifest.entry,
            styles: manifest.styles.map((style) => asset(base, style)!),
            apiVersion: 1,
          },
        }
      : {}),
  }
}

async function hydrate(id: ExtensionID, row: RegistryRow, base: (manifest: Loaded) => string): Promise<Info> {
  try {
    if (row.source.type === "path") await assertDevelopmentDirectory(row.dir)
    const manifest = installedManifest(row, await load(row.dir))
    if (manifest.id !== id) throw new Error(`Extension id changed from ${id} to ${manifest.id}`)
    return info(row, manifest, base(manifest))
  } catch (error) {
    const incompatible = error instanceof CompatibilityError
    return {
      id,
      name: row.name,
      version: row.version,
      displayName: row.name,
      source: row.source,
      enabled: row.enabled,
      state: incompatible ? "incompatible" : "error",
      error: error instanceof Error ? error.message : String(error),
      activation: [],
      contributes: {},
      permissions: [],
      // The manifest is unreadable, so setting definitions are unknown; return
      // no values instead of leaking stored (potentially secret) ones.
      settings: {},
    }
  }
}

export async function list(base: (manifest: Loaded) => string = () => "", target = file()): Promise<Info[]> {
  const store = await Flock.withLock(lock(target), () => readStore(target))
  return Promise.all(
    Object.entries(store.extensions)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([id, row]) => hydrate(id as ExtensionID, row, base)),
  )
}

export async function get(id: ExtensionID, base: (manifest: Loaded) => string = () => "", target = file()) {
  const store = await Flock.withLock(lock(target), () => readStore(target))
  const row = store.extensions[id]
  if (!row) throw new NotFoundError(id)
  return hydrate(id, row, base)
}

export async function linked(
  id: ExtensionID,
  target = file(),
): Promise<{ row: RegistryRow; manifest: Loaded } | undefined> {
  const store = await Flock.withLock(lock(target), () => readStore(target))
  const row = store.extensions[id]
  if (!row) return
  if (row.source.type === "path") await assertDevelopmentDirectory(row.dir)
  const manifest = installedManifest(row, await load(row.dir))
  if (manifest.id !== id) throw new ConflictError("Extension manifest id changed")
  return { row, manifest }
}

export async function link(directory: string, base: (manifest: Loaded) => string = () => "", target = file()) {
  const dir = Filesystem.resolve(directory)
  await assertDevelopmentDirectory(dir)
  const manifest = await load(dir)
  const row = await Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const retained = store.retained?.[manifest.id]
    if (retained?.purging) throw new ConflictError("Extension data cleanup must finish before linking")
    if (
      retained &&
      retained.purgedAt === undefined &&
      (retained.name !== manifest.name ||
        sourceIdentity(retained.source) !== sourceIdentity({ type: "path", path: dir }))
    ) {
      throw new ConflictError("Extension data belongs to a different installation")
    }
    const previous = store.extensions[manifest.id]
    if (previous && (previous.name !== manifest.name || previous.source.type !== "path")) {
      throw new ConflictError(`Extension id is already installed: ${manifest.id}`)
    }
    const inherited = previous ?? (retained?.purgedAt === undefined ? retained : undefined)
    if (!previous && inherited) {
      assertSettingsCompatible(
        manifest.id,
        {
          name: manifest.name,
          version: manifest.version,
          source: { type: "path", path: dir },
          dir,
          enabled: true,
          installedAt: Date.now(),
          settings: inherited.settings,
          secretKeys: inherited.secretKeys,
        },
        manifest,
      )
    }
    for (const [id, entry] of Object.entries(store.extensions)) {
      if (id === manifest.id || Filesystem.resolve(entry.dir) !== dir) continue
      delete store.extensions[id as ExtensionID]
    }
    const next: RegistryRow = {
      name: manifest.name,
      version: manifest.version,
      source: { type: "path", path: dir },
      dir,
      enabled: previous?.enabled ?? true,
      installedAt: previous?.installedAt ?? Date.now(),
      revision: nextRevision(store),
      secretKeys: [...new Set([...(inherited?.secretKeys ?? []), ...secretKeys(manifest)])],
      // Settings belong to the extension id, including a same-source retained
      // tombstone restored after the default (non-purge) uninstall.
      ...(inherited?.settings ? { settings: inherited.settings } : {}),
    }
    store.extensions[manifest.id] = next
    if (store.retained) delete store.retained[manifest.id]
    await writeStore(target, store)
    return next
  })
  publish({ id: manifest.id, version: manifest.version, state: "installed" })
  return info(row, manifest, base(manifest))
}

export async function setEnabled(
  id: ExtensionID,
  enabled: boolean,
  base: (manifest: Loaded) => string = () => "",
  target = file(),
) {
  let row: RegistryRow
  await Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const current = store.extensions[id]
    if (!current) throw new NotFoundError(id)
    row = { ...current, enabled, revision: nextRevision(store) }
    store.extensions[id] = row
    await writeStore(target, store)
  })
  try {
    const manifest = installedManifest(row!, await load(row!.dir))
    publish({ id, version: manifest.version, state: enabled ? "enabled" : "disabled" })
    return info(row!, manifest, base(manifest))
  } catch (error) {
    publishError(id, row!.version, error)
    return hydrate(id, row!, base)
  }
}

function assertSettingValue(id: ExtensionID, key: string, definition: SettingDefinition, value: unknown) {
  const label = `Extension setting "${id}:${key}"`
  switch (definition.type) {
    case "string":
      if (typeof value !== "string") throw new SettingsError(`${label} must be a string`)
      break
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new SettingsError(`${label} must be a finite number`)
      break
    case "boolean":
      if (typeof value !== "boolean") throw new SettingsError(`${label} must be a boolean`)
      break
    default:
      throw new SettingsError(`${label} declares an unsupported type: ${(definition as { type: string }).type}`)
  }
  if (definition.enum && !(definition.enum as Array<string | number>).includes(value as string | number)) {
    throw new SettingsError(
      `${label} must be one of: ${definition.enum.map((option) => JSON.stringify(option)).join(", ")}`,
    )
  }
}

/**
 * Apply a partial settings patch to an installed extension. Unknown keys are
 * rejected, values are checked against the manifest's `contributes.settings`
 * declaration (type + enum), and `undefined` removes a stored value so the
 * manifest default applies again. Runs under the registry flock with a single
 * read-modify-write cycle so concurrent CLI/server writers stay consistent.
 */
export async function updateSettings(
  id: ExtensionID,
  patch: Record<string, unknown>,
  base: (manifest: Loaded) => string = () => "",
  target = file(),
): Promise<Info> {
  let row: RegistryRow
  let manifest: Loaded
  await Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const current = store.extensions[id]
    if (!current) throw new NotFoundError(id)
    manifest = installedManifest(current, await load(current.dir))
    const definitions = manifest.contributes.settings ?? {}
    const merged: Record<string, unknown> = { ...(current.settings ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      const definition = definitions[key]
      if (!definition) throw new SettingsError(`Unknown extension setting "${id}:${key}"`)
      if (value === undefined) {
        delete merged[key]
        continue
      }
      if ((definition.secret || current.secretKeys?.includes(key)) && value === SECRET_MASK) continue
      assertSettingValue(id, key, definition, value)
      merged[key] = value
    }
    row = {
      ...current,
      revision: nextRevision(store),
      secretKeys: [...new Set([...(current.secretKeys ?? []), ...secretKeys(manifest)])],
    }
    if (Object.keys(merged).length > 0) row.settings = merged
    else delete row.settings
    store.extensions[id] = row
    await writeStore(target, store)
  })
  publish({ id, version: manifest!.version, state: "changed" })
  return info(row!, manifest!, base(manifest!))
}

function secretKeys(manifest: Loaded) {
  return Object.entries(manifest.contributes.settings ?? {})
    .filter(([, definition]) => definition.secret)
    .map(([key]) => key)
}

export function assertSettingsCompatible(id: ExtensionID, current: RegistryRow, manifest: Loaded, previous?: Loaded) {
  const definitions = manifest.contributes.settings ?? {}
  const secrets = new Set([...(current.secretKeys ?? []), ...(previous ? secretKeys(previous) : [])])
  for (const [key, value] of Object.entries(current.settings ?? {})) {
    const definition = definitions[key]
    if (!definition || (secrets.has(key) && !definition.secret)) {
      throw new SettingsError(`Extension setting requires explicit migration: ${id}:${key}`)
    }
    assertSettingValue(id, key, definition, value)
  }
}

export async function snapshot(id: ExtensionID, target = file()) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    return { registryVersion: store.version, row: store.extensions[id], retained: store.retained?.[id] }
  })
}

export async function snapshotAll(target = file()) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    return { registryVersion: store.version, revision: store.revision ?? 0, rows: store.extensions }
  })
}

export async function generationReferences(target = file()) {
  return Flock.withLock(lock(target), async () =>
    Object.values((await readStore(target)).extensions).map(({ installId, dir }) => ({ installId, dir })),
  )
}

export async function withUnreferencedGeneration<T>(installId: string, run: () => Promise<T>, target = file()) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const generation = generationPath(target, installId)
    if (
      Object.values(store.extensions).some((row) => {
        const relative = path.relative(generation, Filesystem.resolve(row.dir))
        return (
          row.installId === installId ||
          (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        )
      })
    )
      return { collected: false }
    return { collected: true, value: await run() }
  })
}

function markPurgeCompleted(store: Store, id: ExtensionID, revision: number) {
  for (const receipt of Object.values(store.receipts ?? {})) {
    if (
      receipt.kind === "uninstall" &&
      receipt.extensionID === id &&
      receipt.purgeData &&
      receipt.retainedRevision === revision
    ) {
      receipt.purgeCompleted = true
    }
  }
}

export async function finishPurge(id: ExtensionID, expectedPurgeRevision: number, target = file()) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const retained = store.retained?.[id]
    if (
      store.extensions[id] ||
      !retained ||
      !retained.purging ||
      retained.purgeRevision !== expectedPurgeRevision ||
      retained.purgedAt === undefined
    ) {
      throw new ConflictError("Extension purge identity changed")
    }
    retained.purging = false
    markPurgeCompleted(store, id, expectedPurgeRevision)
    retained.revision = nextRevision(store)
    await writeStore(target, store)
  })
}

export async function withPurge<T>(
  id: ExtensionID,
  expectedRetainedRevision: number,
  run: (identity: {
    name: string
    source: Source
    dataSource?: RegistryRow["dataSource"]
    revision: number
  }) => Promise<T>,
  target = file(),
) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    if (store.extensions[id]) throw new ConflictError("Installed extensions cannot have their data purged")
    const retained = store.retained?.[id]
    if (
      !retained ||
      (retained.revision !== expectedRetainedRevision && retained.purgeRevision !== expectedRetainedRevision)
    ) {
      throw new ConflictError("Extension data changed; prepare the operation again")
    }
    if (retained.purgedAt !== undefined && !retained.purging) return { purged: true, value: undefined }
    // Persist intent before touching files. If the process dies after a rename,
    // a new installation must not inherit a partially purged data namespace.
    retained.purging = true
    retained.purgeRevision ??= expectedRetainedRevision
    await writeStore(target, store)
    const value = await run({
      name: retained.name,
      source: retained.source,
      dataSource: retained.dataSource,
      revision: retained.purgeRevision,
    })
    delete retained.settings
    retained.secretKeys = []
    retained.purgedAt = Date.now()
    // A pending trash journal keeps the namespace fenced until finishPurge.
    retained.purging =
      typeof value === "object" && value !== null && "cleanupPending" in value && value.cleanupPending === true
    if (!retained.purging) markPurgeCompleted(store, id, retained.purgeRevision)
    retained.revision = nextRevision(store)
    await writeStore(target, store)
    return { purged: true, value }
  })
}

export async function updateCleanupReceipt(
  operationID: string,
  tokenHash: string,
  cleanupPending: boolean,
  target = file(),
) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const receipt = store.receipts?.[operationID]
    if (!receipt || receipt.tokenHash !== tokenHash) throw new ConflictError("Unknown extension cleanup receipt")
    if (receipt.cleanupPending === cleanupPending) return receipt
    receipt.cleanupPending = cleanupPending
    nextRevision(store)
    await writeStore(target, store)
    return receipt
  })
}

export async function pendingCleanup(target = file()) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    return Object.values(store.receipts ?? {})
      .filter((item) => item.cleanupPending)
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        extensionID: item.extensionID,
        installId: item.installId,
        previousInstallId: item.previousInstallId,
        purgeData: item.purgeData ?? false,
        purgeCompleted: item.purgeCompleted ?? false,
        retainedRevision: item.retainedRevision,
      }))
  })
}

export async function finishCleanupReceipt(operationID: string, target = file()) {
  return Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const item = store.receipts?.[operationID]
    if (!item || !item.cleanupPending) return
    item.cleanupPending = false
    nextRevision(store)
    await writeStore(target, store)
  })
}

export async function receipt(operationID: string, target = file()) {
  return Flock.withLock(lock(target), async () => (await readStore(target)).receipts?.[operationID])
}

export async function commitInstallation(
  input: {
    id: ExtensionID
    row: RegistryRow
    expectedRevision: number | undefined
    expectedRetainedRevision?: number
    expectedRegistryVersion?: number
    acceptRegistryUpgrade?: boolean
    receipt: OperationReceipt
  },
  base: (manifest: Loaded) => string = () => "",
  target = file(),
) {
  if (input.row.source.type === "path" || !input.row.installId) throw new ConflictError("Expected managed installation")
  await ownedGeneration(target, input.row)
  if (
    input.receipt.extensionID !== input.id ||
    input.receipt.installId !== input.row.installId ||
    !["install", "update"].includes(input.receipt.kind)
  )
    throw new ConflictError("Invalid installation receipt")
  const manifest = installedManifest(input.row, await load(input.row.dir))
  if (manifest.id !== input.id || manifest.name !== input.row.name || manifest.version !== input.row.version) {
    throw new ConflictError("Extension candidate identity changed")
  }
  const row = await Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const previousReceipt = store.receipts?.[input.receipt.id]
    if (previousReceipt) {
      if (
        previousReceipt.tokenHash !== input.receipt.tokenHash ||
        previousReceipt.kind !== input.receipt.kind ||
        previousReceipt.extensionID !== input.id ||
        previousReceipt.installId !== input.row.installId
      ) {
        throw new ConflictError("Extension operation identity changed")
      }
      const existing = store.extensions[input.id]
      if (!existing || existing.installId !== previousReceipt.installId) {
        throw new ConflictError("Extension installation has changed since the operation committed")
      }
      return existing
    }
    if (input.row.source.type === "release") {
      if (input.expectedRegistryVersion === undefined) {
        throw new ConflictError("Release installation requires an expected registry version")
      }
      if (
        !Schema.is(ReleaseSource)(input.row.source) ||
        input.row.source.extensionID !== input.id ||
        input.row.source.version !== input.row.version
      ) {
        throw new ConflictError("Invalid release source identity")
      }
    }
    if (input.expectedRegistryVersion !== undefined && input.expectedRegistryVersion !== store.version) {
      throw new ConflictError("Extension registry version changed; prepare the operation again")
    }
    if (input.row.source.type === "release" && store.version === 2 && input.acceptRegistryUpgrade !== true) {
      throw new ConflictError("Extension registry upgrade requires explicit confirmation")
    }
    const current = store.extensions[input.id]
    if ((current ? (current.revision ?? 0) : undefined) !== input.expectedRevision) {
      throw new ConflictError("Extension changed; prepare the operation again")
    }
    const retained = store.retained?.[input.id]
    if (retained?.purging)
      throw new ConflictError("Previous uninstall cleanup is still running; retry the installation once it finishes")
    if (!current && retained && retained.revision !== input.expectedRetainedRevision) {
      throw new ConflictError("Extension data changed; prepare the operation again")
    }
    // A retained tombstone without an active purge no longer blocks the
    // installation: it is consumed independently by the cleanup state machine
    // (recovery purges or finishes it), so a reinstall after a deferred
    // uninstall cannot be permanently blocked by its own retained record.
    // Archive releases necessarily change both digest and download/staging path.
    // A confirmed update capability (bound to this id, candidate tree and current
    // row revision) explicitly authorizes that replacement. Do not grant the same
    // exception to installs, retained-data inheritance or other source families.
    const archiveUpdate =
      input.receipt.kind === "update" && current?.source.type === "archive" && input.row.source.type === "archive"
    if (
      current &&
      (current.name !== input.row.name ||
        current.source.type === "path" ||
        (!archiveUpdate && sourceIdentity(current.source) !== sourceIdentity(input.row.source)))
    ) {
      throw new ConflictError("Extension id belongs to a different installation")
    }
    // The runtime's data/cache directories are keyed by id, not source. Until
    // data namespaces can be migrated explicitly, a new source must not gain
    // access to the previous installation's retained files.
    // For archive sources the acquisition location is a temporary path, so
    // byte identity (sha256) decides inheritance here: reinstalling the same
    // archive after a deferred uninstall inherits its data, a different
    // archive does not. Other source types keep the exact-identity rule.
    const retainedIdentityMatches = (() => {
      if (!retained) return true
      if (sourceIdentity(retained.source) === sourceIdentity(input.row.source)) return true
      // Archive acquisitions normally differ by their temporary location;
      // byte identity (sha256) is the durable sameness for them.
      if (retained.source.type === "archive" && input.row.source.type === "archive") {
        return retained.source.sha256 === input.row.source.sha256
      }
      return false
    })()
    if (
      !current &&
      retained &&
      retained.purgedAt === undefined &&
      (retained.name !== input.row.name || !retainedIdentityMatches)
    ) {
      throw new ConflictError("Extension data belongs to a different installation")
    }
    const inherited = current ?? retained
    const previous = current ? await load(current.dir).catch(() => undefined) : undefined
    // Old v1 rows may not carry secret classifications. If their manifest is
    // broken, conservatively treat every stored key as secret during repair.
    const inheritedSecrets = inherited?.secretKeys ?? (current && !previous ? Object.keys(current.settings ?? {}) : [])
    if (inherited) {
      assertSettingsCompatible(
        input.id,
        {
          ...input.row,
          settings: inherited.settings,
          secretKeys: inheritedSecrets,
        },
        manifest,
        previous,
      )
    }
    const dataOwner = current ?? (retained?.purgedAt === undefined ? retained : undefined)
    const next: RegistryRow = {
      ...input.row,
      // Never accept a candidate-supplied data lineage. Only a validated current
      // row or same-archive retained tombstone can authorize data inheritance.
      dataSource:
        dataOwner?.dataSource ??
        (dataOwner?.source.type === "archive" && input.row.source.type === "archive" ? dataOwner.source : undefined),
      enabled: current?.enabled ?? input.row.enabled,
      installedAt: current?.installedAt ?? input.row.installedAt,
      settings: inherited?.settings,
      secretKeys: [...new Set([...inheritedSecrets, ...secretKeys(manifest)])],
      revision: nextRevision(store),
      updatedAt: Date.now(),
    }
    if (input.row.source.type === "release") store.version = 3
    store.extensions[input.id] = next
    store.receipts ??= {}
    store.receipts[input.receipt.id] = input.receipt
    if (store.retained) delete store.retained[input.id]
    await writeStore(target, store)
    return next
  })
  publish({ id: input.id, version: row.version, state: "installed" })
  return info(row, manifest, base(manifest))
}

export async function commitRemoval(
  input: {
    id: ExtensionID
    expectedRevision: number
    expectedRegistryVersion?: number
    receipt: OperationReceipt
    purgeData: boolean
  },
  target = file(),
) {
  if (input.receipt.extensionID !== input.id || input.receipt.kind !== "uninstall") {
    throw new ConflictError("Invalid removal receipt")
  }
  const previous = await Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    if (store.receipts?.[input.receipt.id]) {
      const existing = store.receipts[input.receipt.id]
      if (
        existing.tokenHash !== input.receipt.tokenHash ||
        existing.kind !== "uninstall" ||
        existing.extensionID !== input.id
      ) {
        throw new ConflictError("Extension operation identity changed")
      }
      return
    }
    if (input.expectedRegistryVersion !== undefined && input.expectedRegistryVersion !== store.version) {
      throw new ConflictError("Extension registry version changed; prepare the operation again")
    }
    const current = store.extensions[input.id]
    if (!current || (current.revision ?? 0) !== input.expectedRevision) {
      throw new ConflictError("Extension changed; prepare the operation again")
    }
    store.retained ??= {}
    const manifest = await load(current.dir).catch(() => undefined)
    store.retained[input.id] = {
      name: current.name,
      source: current.source,
      dataSource: current.dataSource,
      settings: input.purgeData ? undefined : current.settings,
      secretKeys: [
        ...new Set([
          ...(current.secretKeys ?? []),
          ...(manifest ? secretKeys(manifest) : Object.keys(current.settings ?? {})),
        ]),
      ],
      revision: nextRevision(store),
    }
    delete store.extensions[input.id]
    store.receipts ??= {}
    store.receipts[input.receipt.id] = { ...input.receipt, retainedRevision: store.retained[input.id].revision }
    await writeStore(target, store)
    return current
  })
  if (previous) publish({ id: input.id, version: previous.version, state: "removed" })
  return previous
}

export async function resetForTesting() {
  // Registry state is intentionally read from disk on every operation. This
  // helper exists so tests can document that no in-memory cache survives.
}

export * as ExtensionRegistry from "./registry"
