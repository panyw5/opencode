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
import { RegistryStore, type ExtensionID, type Info, type RegistryRow, type RegistryStore as Store } from "./schema"

export class NotFoundError extends Error {
  override readonly name = "ExtensionNotFoundError"

  constructor(readonly id: ExtensionID) {
    super(`Extension not found: ${id}`)
  }
}

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
    await writeFile(temp, `${JSON.stringify(store, null, 2)}\n`, { flag: "wx" })
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
    web: {
      base,
      entry: manifest.entry,
      styles: manifest.styles.map((style) => asset(base, style)!),
      apiVersion: 1,
    },
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

export async function resetForTesting() {
  // Registry state is intentionally read from disk on every operation. This
  // helper exists so tests can document that no in-memory cache survives.
}

export * as ExtensionRegistry from "./registry"
