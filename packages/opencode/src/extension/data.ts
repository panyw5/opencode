import path from "node:path"
import { constants } from "node:fs"
import { lstat, open, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { Global } from "@opencode-ai/core/global"
import { ID_PATTERN, type Source } from "./schema"
import { canonicalRegistryFile, privateDirectory } from "./paths"
import { sourceIdentity } from "./registry"

const OWNER = "opencode.extension-data"
type DataIdentity = { id: string; name: string; source: Source }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function locations(id: string) {
  if (!ID_PATTERN.test(id) || id.length > 64) throw new Error("Invalid extension data identity")
  const dataRoot = path.dirname(canonicalRegistryFile(path.join(Global.Path.data, "extensions", "registry.json")))
  const cacheRoot = path.dirname(canonicalRegistryFile(path.join(Global.Path.cache, "extensions", "registry.json")))
  return {
    dataRoot,
    cacheRoot,
    data: path.join(dataRoot, "data", id),
    cache: path.join(cacheRoot, id),
    owner: path.join(dataRoot, "data-ownership", `${id}.json`),
    pending: path.join(dataRoot, "data-purge", `${id}.json`),
  }
}

function record(identity: DataIdentity) {
  const paths = locations(identity.id)
  return {
    version: 1,
    owner: OWNER,
    id: identity.id,
    name: identity.name,
    sourceHash: digest(sourceIdentity(identity.source)),
    dataHash: digest(paths.data),
    cacheHash: digest(paths.cache),
  }
}

async function readOwner(file: string) {
  const before = await lstat(file)
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Unsafe data ownership")
  await privateDirectory(path.dirname(file))
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Data ownership changed")
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o777) !== 0o600
    )
      throw new Error("Unsafe data ownership")
    const bytes = Buffer.alloc(4097)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== stat.size) throw new Error("Data ownership changed")
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown
  } finally {
    await handle.close()
  }
}

type Quarantine = { kind: "data" | "cache"; name: string; dev: number; ino: number }
type PurgeJournal = {
  version: 1
  owner: "opencode.extension-purge"
  identity: ReturnType<typeof record>
  entries: Quarantine[]
}

async function purgeJournal(file: string): Promise<PurgeJournal | undefined> {
  const raw = await readOwner(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (raw === undefined) return
  const value = raw as PurgeJournal
  if (
    value.version !== 1 ||
    value.owner !== "opencode.extension-purge" ||
    !Array.isArray(value.entries) ||
    value.entries.length > 2 ||
    new Set(value.entries.map((item) => item.kind)).size !== value.entries.length ||
    value.entries.some(
      (item) =>
        !["data", "cache"].includes(item.kind) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.name) ||
        !Number.isSafeInteger(item.dev) ||
        !Number.isSafeInteger(item.ino),
    )
  )
    throw new Error("Invalid data purge journal")
  return value
}
async function writeJournal(file: string, value: PurgeJournal) {
  await privateDirectory(path.dirname(file))
  const temp = path.join(path.dirname(file), `.purge-${randomUUID()}.tmp`)
  try {
    await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/** Called under the extension's data-reference gate. Never adopts legacy files. */
export async function provisionData(identity: DataIdentity) {
  const paths = locations(identity.id)
  const wanted = record(identity)
  if (await purgeJournal(paths.pending)) throw new Error("Extension data purge must finish before loading")
  const existing = await readOwner(paths.owner).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(wanted)) throw new Error("Extension data belongs to another source")
    return
  }
  if (identity.source.type === "path") return // Do not adopt unowned legacy development data.
  for (const target of [paths.data, paths.cache]) {
    if (await lstat(target).catch(() => undefined)) throw new Error("Extension data ownership is unknown")
  }
  await privateDirectory(path.dirname(paths.owner))
  await writeFile(paths.owner, JSON.stringify(wanted), { flag: "wx", mode: 0o600 }).catch(
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" || JSON.stringify(await readOwner(paths.owner)) !== JSON.stringify(wanted))
        throw error
    },
  )
}

/** The caller holds the shared data-reference gate and registry purge claim. */
export async function quarantineData(identity: DataIdentity) {
  const paths = locations(identity.id)
  const previous = await purgeJournal(paths.pending)
  if (previous && JSON.stringify(previous.identity) !== JSON.stringify(record(identity))) {
    throw new Error("Data purge journal belongs to another source")
  }
  const candidates: Array<{ target: string; dev: number; ino: number }> = []
  for (const target of [paths.data, paths.cache]) {
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) continue
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.mode & 0o022
    ) {
      throw new Error("Unsafe extension data directory")
    }
    await privateDirectory(target)
    candidates.push({ target, dev: stat.dev, ino: stat.ino })
  }
  const owner = await readOwner(paths.owner).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  // Global ownership exists independently of lazy data/cache directory creation.
  // Another registry's source must not erase an empty namespace's provenance.
  if ((owner !== undefined || candidates.length > 0) && JSON.stringify(owner) !== JSON.stringify(record(identity))) {
    throw new Error("Extension data ownership is unknown")
  }
  const journal: PurgeJournal = previous ?? {
    version: 1,
    owner: "opencode.extension-purge",
    identity: record(identity),
    entries: [],
  }
  for (const candidate of candidates) {
    const kind = candidate.target === paths.data ? ("data" as const) : ("cache" as const)
    const old = journal.entries.find((item) => item.kind === kind)
    if (old && (old.dev !== candidate.dev || old.ino !== candidate.ino)) throw new Error("Data purge source changed")
    if (!old) journal.entries.push({ kind, name: randomUUID(), dev: candidate.dev, ino: candidate.ino })
  }
  // Record destination identities before any rename so a crash cannot orphan
  // quarantined user data or make a later purge report false completion.
  await writeJournal(paths.pending, journal)
  const moved: Array<{ target: string; dev: number; ino: number }> = []
  for (const entry of journal.entries) {
    const root = entry.kind === "data" ? paths.dataRoot : paths.cacheRoot
    const source = entry.kind === "data" ? paths.data : paths.cache
    const trash = await privateDirectory(path.join(root, "data-trash"))
    const destination = path.join(trash, entry.name)
    const current = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (current) {
      if (
        current.dev !== entry.dev ||
        current.ino !== entry.ino ||
        !current.isDirectory() ||
        current.isSymbolicLink()
      ) {
        throw new Error("Extension data changed during purge")
      }
      if (await lstat(destination).catch(() => undefined)) throw new Error("Data purge destination exists")
      await rename(source, destination)
    }
    const quarantined = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!quarantined) continue // A prior recovery already removed this owned tree.
    if (
      quarantined.dev !== entry.dev ||
      quarantined.ino !== entry.ino ||
      !quarantined.isDirectory() ||
      quarantined.isSymbolicLink()
    ) {
      throw new Error("Data purge quarantine changed")
    }
    moved.push({ target: destination, dev: entry.dev, ino: entry.ino })
  }
  // Remove ownership only after every source directory has been quarantined.
  await unlink(paths.owner).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  return {
    cleanupPending: moved.length > 0,
    async finish() {
      let remaining = 0
      let entries = 0
      async function remove(target: string, expected: { dev: number; ino: number }, depth: number) {
        if (depth > 64 || ++entries > 50_000) throw new Error("Data cleanup limit exceeded")
        const stat = await lstat(target)
        if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error("Data cleanup identity changed")
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await privateDirectory(target)
          for (const name of await readdir(target)) {
            const child = path.join(target, name)
            await remove(child, await lstat(child), depth + 1)
          }
          const after = await lstat(target)
          if (
            after.dev !== expected.dev ||
            after.ino !== expected.ino ||
            !after.isDirectory() ||
            after.isSymbolicLink()
          )
            throw new Error("Data cleanup changed")
          await rmdir(target)
        } else await unlink(target) // Never follows a link to its target.
      }
      for (const target of moved) {
        try {
          await remove(target.target, target, 0)
        } catch {
          remaining++
        }
      }
      if (remaining === 0)
        await unlink(paths.pending).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      return remaining === 0
    },
  }
}
