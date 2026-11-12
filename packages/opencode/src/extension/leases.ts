import path from "node:path"
import { randomUUID } from "node:crypto"
import { constants, realpathSync, type Stats } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const EXTENSION_ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/
const nonce = randomUUID()
type Namespace = "generation" | "operation" | "data"
type Identity = { dev: number; ino: number }
type Driver = { lock(fd: number): boolean }
type Reference = { handle?: FileHandle; count: number; proof: "flock" | "unsupported" }
const references = new Map<string, Reference>()
let driver: Promise<Driver | undefined> | undefined

/** This is deliberately NOT core/util/flock: that utility evicts locks by heartbeat TTL. */
export namespace ExtensionLeases {
  export class LeaseError extends Error {
    override readonly name = "ExtensionLeaseError"
    constructor(
      readonly code: "invalid" | "unsafe" | "busy",
      message: string,
      /** Set when the portable mkdir gate itself is held; only an explicit user unlock may clear it. */
      readonly gate?: Namespace,
    ) {
      super(message)
    }
  }
  export type UnlockReport = { removed: Namespace[]; recent: Namespace[]; untrusted: Namespace[] }
  /**
   * Explicit, user-confirmed recovery for gates abandoned by a killed process. Never called automatically:
   * gates are held for milliseconds, so only gates older than `minAgeMs` are removed, and only when the
   * directory identity is unchanged between inspection and removal.
   */
  export async function unlockStaleGates(registry: string, minAgeMs = 30_000): Promise<UnlockReport> {
    const report: UnlockReport = { removed: [], recent: [], untrusted: [] }
    for (const namespace of ["generation", "operation", "data"] as const) {
      const { refs } = await refsFor(registry, namespace)
      const gate = path.join(refs, ".gate")
      let before: Stats
      try {
        before = await lstat(gate)
      } catch (error) {
        if (code(error) === "ENOENT") continue
        throw error
      }
      if (!before.isDirectory() || before.isSymbolicLink()) {
        report.untrusted.push(namespace)
        continue
      }
      if (Date.now() - before.mtimeMs < minAgeMs) {
        report.recent.push(namespace)
        continue
      }
      const entries = await readdir(gate)
      if (entries.some((entry) => entry !== "owner")) {
        report.untrusted.push(namespace)
        continue
      }
      // Atomic rename first: a concurrent unlocker or a fresh owner can never lose a newer gate silently.
      const tombstone = path.join(refs, `.gate-stale-${randomUUID()}`)
      await rename(gate, tombstone)
      if (!same(before, await lstat(tombstone))) {
        await rename(tombstone, gate).catch(() => {})
        report.untrusted.push(namespace)
        continue
      }
      await unlink(path.join(tombstone, "owner")).catch((error) => {
        if (code(error) !== "ENOENT") throw error
      })
      await rmdir(tombstone)
      report.removed.push(namespace)
    }
    return report
  }

  export type Lease = {
    readonly proof: "flock" | "unsupported"
    release(): Promise<void>
    [Symbol.asyncDispose](): Promise<void>
  }
  export type ExclusiveResult<T> = { status: "collected"; value: T } | { status: "busy"; reason: string }
  export type Inspection = { status: "idle" | "live"; leases: string[] } | { status: "busy"; reason: string }

  /** registry is the registry JSON file, not its storage directory. */
  export function acquire(registry: string, installId: string): Promise<Lease> {
    return acquireReference(registry, "generation", installId)
  }
  export function acquireOperation(registry: string, operationId: string): Promise<Lease> {
    return acquireReference(registry, "operation", operationId)
  }
  /** Data is shared by all registry overrides. The registry argument is not its storage identity. Pin before import. */
  export function acquireData(registry: string, extensionId: string): Promise<Lease> {
    return acquireReference(registry, "data", extensionId)
  }
  export function withExclusiveGeneration<T>(registry: string, id: string, fn: () => Promise<T>) {
    return exclusive(registry, "generation", id, fn)
  }
  export function withExclusiveOperation<T>(registry: string, id: string, fn: () => Promise<T>) {
    return exclusive(registry, "operation", id, fn)
  }
  export function withExclusiveData<T>(registry: string, id: string, fn: () => Promise<T>) {
    return exclusive(registry, "data", id, fn)
  }
  /** An OS-lock proof, never an mtime/PID/heartbeat-based guess. Missing or untrusted proof is busy. */
  export async function list(registry: string, id: string): Promise<Inspection> {
    try {
      const layout = await locations(registry, "generation", id)
      return await gated(layout, false, () => inspect(layout))
    } catch (error) {
      return { status: "busy", reason: reason(error) }
    }
  }
}

type Layout = Awaited<ReturnType<typeof locations>>
function fail(message: string): never {
  throw new ExtensionLeases.LeaseError("unsafe", message)
}
function reason(error: unknown) {
  return error instanceof Error ? error.message : "Untrusted extension lease state"
}
function code(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code
}
function same(a: Identity, b: Identity) {
  return a.dev === b.dev && a.ino === b.ino
}
function rootFor(registry: string) {
  if (typeof registry !== "string" || !registry || registry.includes("\0")) {
    throw new ExtensionLeases.LeaseError("invalid", "Invalid extension registry path")
  }
  // Match canonicalRegistryFile's existing-ancestor semantics, without importing configuration/global state.
  let parent = path.dirname(path.resolve(registry))
  const pending: string[] = []
  while (true) {
    try {
      return path.join(realpathSync(parent), ...pending)
    } catch (error) {
      if (code(error) !== "ENOENT") throw error
      const next = path.dirname(parent)
      if (next === parent) throw error
      pending.unshift(path.basename(parent))
      parent = next
    }
  }
}
async function locations(registry: string, namespace: Namespace, id: string) {
  if (typeof id !== "string" || (namespace === "data" ? id.length > 64 || !EXTENSION_ID.test(id) : !UUID.test(id))) {
    throw new ExtensionLeases.LeaseError("invalid", "Invalid extension lease identity")
  }
  const { root, refs } = await refsFor(registry, namespace)
  return { root, refs, directory: path.join(refs, id), gate: path.join(refs, ".gate"), namespace, id }
}
async function refsFor(registry: string, namespace: Namespace) {
  const root =
    namespace === "data"
      ? rootFor(path.join((await import("@opencode-ai/core/global")).Global.Path.data, "extensions", "registry.json"))
      : rootFor(registry)
  return { root, refs: path.join(root, namespace === "generation" ? "ref" : `${namespace}-ref`) }
}
async function directory(target: string) {
  const info = await lstat(target)
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target) {
    fail("Extension lease storage is not an owned canonical directory")
  }
  return info
}
async function ensureDirectory(target: string): Promise<void> {
  try {
    await directory(target)
    return
  } catch (error) {
    if (code(error) !== "ENOENT") throw error
  }
  const parent = path.dirname(target)
  if (parent === target) fail("Missing extension lease storage root")
  await ensureDirectory(parent)
  await mkdir(target, { mode: 0o700 }).catch((error) => {
    if (code(error) !== "EEXIST") throw error
  })
  await directory(target)
}
async function ancestry(layout: Layout) {
  await directory(layout.root)
  await directory(layout.refs)
}

/** Portable gate shared by native and non-native drivers. Never steal it, regardless of age. */
async function gated<T>(layout: Layout, create: boolean, fn: () => Promise<T>): Promise<T> {
  if (create) {
    await ensureDirectory(layout.root)
    await ensureDirectory(layout.refs)
  }
  await ancestry(layout)
  let acquired = false
  for (let attempt = 0; attempt < (create ? 100 : 1); attempt++) {
    try {
      await mkdir(layout.gate, { mode: 0o700 })
      acquired = true
      break
    } catch (error) {
      if (code(error) !== "EEXIST") throw error
      if (create) await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  if (!acquired)
    throw new ExtensionLeases.LeaseError("busy", "Extension lease gate is busy (never TTL-reclaimed)", layout.namespace)
  // A crash at any point leaves a fail-closed gate. Only this owner's verified metadata is removed.
  const owned = await directory(layout.gate)
  const token = randomUUID()
  const owner = path.join(layout.gate, "owner")
  const handle = await open(
    owner,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(token)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    return await fn()
  } finally {
    await ancestry(layout)
    if (!same(owned, await directory(layout.gate))) fail("Extension lease gate identity changed")
    if ((await readRegular(owner)).text !== token) fail("Extension lease gate owner changed")
    await unlink(owner)
    await rmdir(layout.gate)
  }
}

async function nativeDriver(): Promise<Driver | undefined> {
  return (driver ??= (async () => {
    if (typeof Bun === "undefined" || (process.platform !== "darwin" && process.platform !== "linux")) return
    try {
      const { dlopen } = await import("bun:ffi")
      const libraries =
        process.platform === "darwin"
          ? ["/usr/lib/libSystem.B.dylib"]
          : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"]
      for (const library of libraries) {
        try {
          const native = dlopen(library, { flock: { args: ["i32", "i32"], returns: "i32" } })
          // Keep the library alive for as long as any reference can hold an OS lock.
          return { lock: (fd: number) => native.symbols.flock(fd, 2 | 4) === 0 }
        } catch {}
      }
    } catch {}
    // Node/Electron, Windows, unavailable FFI: durable marker, never pretend an unlocked file proves death.
    return undefined
  })())
}
async function readRegular(file: string, limit = 2048) {
  const before = await lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit)
    fail("Invalid extension lease file")
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const current = await handle.stat()
    if (!current.isFile() || !same(before, current) || current.nlink !== 1 || current.size > limit)
      fail("Extension lease file changed")
    const text = await handle.readFile("utf8")
    const after = await handle.stat()
    if (!same(current, after) || current.size !== after.size || current.mtimeMs !== after.mtimeMs)
      fail("Extension lease metadata changed")
    return { text, identity: current }
  } finally {
    await handle.close()
  }
}
function metadata(layout: Layout) {
  return { version: 1, namespace: layout.namespace, id: layout.id }
}
function matches(value: unknown, layout: Layout, processNonce?: string, proof?: string) {
  if (!value || typeof value !== "object") return false
  const entry = value as Record<string, unknown>
  const keys = processNonce ? ["version", "namespace", "id", "nonce", "proof"] : ["version", "namespace", "id"]
  return (
    Object.keys(entry).length === keys.length &&
    keys.every((key) => Object.hasOwn(entry, key)) &&
    entry.version === 1 &&
    entry.namespace === layout.namespace &&
    entry.id === layout.id &&
    (!processNonce || (entry.nonce === processNonce && entry.proof === proof))
  )
}
type Owner = { version: number; namespace: Namespace; id: string; leases: Array<Identity & { file: string }> }
async function verifyMetadata(layout: Layout): Promise<Owner> {
  await ancestry(layout)
  await directory(layout.directory)
  const raw = await readRegular(path.join(layout.directory, "owner.json"), 1024 * 1024)
  const owner = JSON.parse(raw.text) as Owner
  if (
    !owner ||
    !matches({ version: owner.version, namespace: owner.namespace, id: owner.id }, layout) ||
    Object.keys(owner).sort().join(",") !== "id,leases,namespace,version" ||
    !Array.isArray(owner.leases) ||
    owner.leases.length > 10000 ||
    new Set(owner.leases.map((entry) => entry?.file)).size !== owner.leases.length ||
    owner.leases.some(
      (entry) =>
        !entry ||
        typeof entry.file !== "string" ||
        !/^([a-f0-9-]{36})\.(lock|unsupported)$/.test(entry.file) ||
        !UUID.test(entry.file.split(".")[0]!) ||
        Object.keys(entry).sort().join(",") !== "dev,file,ino" ||
        !Number.isSafeInteger(entry.dev) ||
        !Number.isSafeInteger(entry.ino),
    )
  ) {
    fail("Invalid extension lease ownership metadata")
  }
  return owner
}
async function addProof(layout: Layout, owner: Owner, file: string, identity: Identity) {
  const existing = owner.leases.find((entry) => entry.file === file)
  if (existing) {
    if (!same(existing, identity)) fail("Extension process lease inode was replaced")
    return
  }
  if (owner.leases.length >= 10000) fail("Extension lease proof limit exceeded")
  const temporary = path.join(layout.directory, `.owner-${randomUUID()}`)
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(
      JSON.stringify({
        ...owner,
        leases: [...owner.leases, { file, dev: identity.dev, ino: identity.ino }].sort((a, b) =>
          a.file.localeCompare(b.file),
        ),
      }),
    )
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path.join(layout.directory, "owner.json"))
}
async function initialize(layout: Layout) {
  let created = false
  try {
    await mkdir(layout.directory, { mode: 0o700 })
    created = true
  } catch (error) {
    if (code(error) !== "EEXIST") throw error
  }
  await directory(layout.directory)
  if (created) {
    const handle = await open(path.join(layout.directory, "owner.json"), "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify({ ...metadata(layout), leases: [] }))
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  return await verifyMetadata(layout)
}
function lease(reference: Reference, key: string): ExtensionLeases.Lease {
  let released: Promise<void> | undefined
  const release = () =>
    (released ??= (async () => {
      reference.count--
      if (reference.count !== 0) return
      if (references.get(key) === reference) references.delete(key)
      // Stable lease inodes and metadata are deliberately never unlinked, including after crashes.
      await reference.handle?.close()
    })())
  return { proof: reference.proof, release, [Symbol.asyncDispose]: release }
}
async function acquireReference(registry: string, namespace: Namespace, id: string): Promise<ExtensionLeases.Lease> {
  try {
    return await acquireReferenceUnsafe(registry, namespace, id)
  } catch (error) {
    if (error instanceof ExtensionLeases.LeaseError) throw error
    throw new ExtensionLeases.LeaseError("unsafe", reason(error))
  }
}
async function acquireReferenceUnsafe(
  registry: string,
  namespace: Namespace,
  id: string,
): Promise<ExtensionLeases.Lease> {
  const layout = await locations(registry, namespace, id)
  return gated(layout, true, async () => {
    // Creators acquire before mkdir/materialization. Readers must revalidate their package after acquiring.
    const owner = await initialize(layout)
    const key = layout.directory
    const current = references.get(key)
    if (current) {
      current.count++
      return lease(current, key)
    }
    const native = await nativeDriver()
    const proof = native ? "flock" : "unsupported"
    const file = path.join(layout.directory, `${nonce}.${native ? "lock" : "unsupported"}`)
    let handle: FileHandle
    let created = false
    try {
      handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      created = true
    } catch (error) {
      if (code(error) !== "EEXIST") throw error
      const existing = await readRegular(file)
      if (!matches(JSON.parse(existing.text), layout, nonce, proof)) fail("Invalid extension process lease metadata")
      handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      if (!same(existing.identity, await handle.stat())) {
        await handle.close()
        fail("Extension process lease identity changed")
      }
    }
    try {
      if (native && !native.lock(handle.fd))
        throw new ExtensionLeases.LeaseError("busy", "Extension process lease is busy")
      if (created) {
        await handle.writeFile(JSON.stringify({ ...metadata(layout), nonce, proof }))
        await handle.sync()
      }
      await addProof(layout, owner, path.basename(file), await handle.stat())
      const reference: Reference = { count: 1, proof, ...(native ? { handle } : {}) }
      if (!native) await handle.close()
      references.set(key, reference)
      return lease(reference, key)
    } catch (error) {
      await handle.close().catch(() => {})
      throw error
    }
  })
}

async function inspect(layout: Layout): Promise<ExtensionLeases.Inspection> {
  const owner = await verifyMetadata(layout)
  const entries = (await readdir(layout.directory)).filter((name) => name !== "owner.json").sort()
  if (
    entries.join("\0") !==
    owner.leases
      .map((entry) => entry.file)
      .sort()
      .join("\0")
  )
    fail("Missing or unexpected extension process lease proof")
  const native = await nativeDriver()
  if (!native) return { status: "busy", reason: "OS lease proof unavailable on this runtime" }
  const live: string[] = []
  let proofs = 0
  for (const name of entries) {
    if (name === "owner.json") continue
    const match = /^([a-f0-9-]{36})\.(lock|unsupported)$/.exec(name)
    if (!match || !UUID.test(match[1]!)) fail("Unknown extension lease metadata")
    if (match[2] === "unsupported")
      return { status: "busy", reason: "A runtime without OS-lock proof used this identity" }
    const file = path.join(layout.directory, name)
    const existing = await readRegular(file)
    const expected = owner.leases.find((entry) => entry.file === name)!
    if (!same(expected, existing.identity)) fail("Extension process lease inode was replaced")
    if (!matches(JSON.parse(existing.text), layout, match[1], "flock")) fail("Corrupt extension process lease metadata")
    const handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!same(existing.identity, await handle.stat())) fail("Extension process lease identity changed")
      if (!native.lock(handle.fd)) live.push(match[1]!)
      proofs++
    } finally {
      // Also releases a successful non-blocking probe. Failure is treated as live, never stale.
      await handle.close()
    }
  }
  if (!proofs && layout.namespace !== "data") return { status: "busy", reason: "Missing extension process lease proof" }
  return { status: live.length ? "live" : "idle", leases: live }
}
async function exclusive<T>(
  registry: string,
  namespace: Namespace,
  id: string,
  fn: () => Promise<T>,
): Promise<ExtensionLeases.ExclusiveResult<T>> {
  let entered = false
  try {
    const layout = await locations(registry, namespace, id)
    return await gated(layout, namespace === "data", async () => {
      // All data users take this same gate before import. An atomically created virgin identity
      // therefore has no readers; never repair a pre-existing directory with missing metadata.
      if (namespace === "data") await initialize(layout)
      const proof = await inspect(layout)
      if (proof.status === "busy") return proof
      if (proof.status === "live") return { status: "busy", reason: "Extension identity has live OS-locked references" }
      entered = true
      return { status: "collected", value: await fn() }
    })
  } catch (error) {
    // A callback error (or compromised gate after it ran) must not be disguised as "not collected".
    if (entered) throw error
    return { status: "busy", reason: reason(error) }
  }
}
