import path from "node:path"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { ConfigParse } from "@/config/parse"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@opencode-ai/core/util/flock"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { load, CompatibilityError, type Loaded } from "./manifest"
import { publish, publishError } from "./event"
import {
  RegistryStore,
  type Contributes,
  type ExtensionID,
  type Info,
  type RegistryRow,
  type RegistryStore as Store,
} from "./schema"

export class NotFoundError extends Error {
  override readonly name = "ExtensionNotFoundError"

  constructor(readonly id: ExtensionID) {
    super(`Extension not found: ${id}`)
  }
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

function file() {
  return Flag.OPENCODE_EXTENSION_REGISTRY_FILE ?? path.join(Global.Path.data, "extensions", "registry.json")
}

function lock(target: string) {
  return `extension-registry:${target}`
}

function empty(): Store {
  return { version: 1, extensions: {} }
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
  return ConfigParse.schema(RegistryStore, json, target)
}

async function writeStore(target: string, store: Store) {
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
    result[key] = definition.secret && value ? SECRET_MASK : value
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
    enabled,
    state: enabled ? "ready" : "disabled",
    activation: manifest.activation,
    contributes: manifest.contributes,
    permissions: manifest.permissions,
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
    const manifest = await load(row.dir)
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
  return { row, manifest: await load(row.dir) }
}

export async function link(
  directory: string,
  base: (manifest: Loaded) => string = () => "",
  target = file(),
) {
  const dir = Filesystem.resolve(directory)
  const manifest = await load(dir)
  const row = await Flock.withLock(lock(target), async () => {
    const store = await readStore(target)
    const previous = store.extensions[manifest.id]
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
      // Settings belong to the extension id, not the linked path: keep them
      // across relinks (e.g. switching a dev link to an installed copy).
      ...(previous?.settings ? { settings: previous.settings } : {}),
    }
    store.extensions[manifest.id] = next
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
    row = { ...current, enabled }
    store.extensions[id] = row
    await writeStore(target, store)
  })
  try {
    const manifest = await load(row!.dir)
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
    manifest = await load(current.dir)
    const definitions = manifest.contributes.settings ?? {}
    const merged: Record<string, unknown> = { ...(current.settings ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      const definition = definitions[key]
      if (!definition) throw new SettingsError(`Unknown extension setting "${id}:${key}"`)
      if (value === undefined) {
        delete merged[key]
        continue
      }
      if (definition.secret && value === SECRET_MASK) continue
      assertSettingValue(id, key, definition, value)
      merged[key] = value
    }
    row = { ...current }
    if (Object.keys(merged).length > 0) row.settings = merged
    else delete row.settings
    store.extensions[id] = row
    await writeStore(target, store)
  })
  publish({ id, version: manifest!.version, state: "changed" })
  return info(row!, manifest!, base(manifest!))
}

export async function resetForTesting() {
  // Registry state is intentionally read from disk on every operation. This
  // helper exists so tests can document that no in-memory cache survives.
}

export * as ExtensionRegistry from "./registry"
