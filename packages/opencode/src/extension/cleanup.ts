import path from "node:path"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { canonicalRegistryFile, extensionPaths, generationPath } from "./paths"
import { ID_PATTERN, type Source } from "./schema"

const OWNER = "opencode.extension-host"
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/

async function writeClaim(file: string, token: string) {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(token)
  } finally {
    await handle.close()
  }
}
const SCAN_LIMIT = 1000
const TREE_LIMIT = 50_000
const METADATA_LIMIT = 4096

type Identity = { dev: number; ino: number }
type Exclusive = <T>(
  registry: string,
  id: string,
  fn: () => Promise<T>,
) => Promise<{ status: "collected"; value: T } | { status: "busy"; reason: string }>
export type CleanupReferences = {
  withExclusiveGeneration: Exclusive
  withExclusiveOperation: Exclusive
}
export type GenerationOwnership = {
  version: 1
  owner: typeof OWNER
  kind: "generation"
  registryHash: string
  operationId: string
  installId: string
  id: string
  name: string
  contentHash: string
  createdAt: number
}
export type OperationOwnership = {
  version: 1
  owner: typeof OWNER
  kind: "operation"
  registryHash: string
  operationId: string
  createdAt: number
}
export type CleanupOptions = {
  registry: string
  references?: CleanupReferences
  now?: () => number
  /** Trusted host/test hook after quarantine and reference-gate release, before recursive deletion. */
  beforeRemove?: () => Promise<void>
  /** Holds the registry flock, verifies no row references the generation, and runs only the short rename callback. */
  withGeneration?: <T>(installId: string, fn: () => Promise<T>) => Promise<{ collected: boolean; value?: T }>
  /** Reserved for the atomic retained-data claim. Never substitute a snapshot check for this guard. */
  withPurge?: <T>(
    id: string,
    expectedRetainedRevision: number,
    fn: (identity: { name: string; source: Source; revision: number }) => Promise<T>,
  ) => Promise<{ purged: boolean; value?: T }>
  /** Validate trusted data/cache ownership and rename only. Throw on unknown ownership; never infer it from a row's dir. */
  renameRetainedData?: (identity: {
    id: string
    name: string
    source: Source
    revision: number
  }) => Promise<{ cleanupPending: boolean }>
}
export type CleanupResult = {
  status: "collected" | "missing" | "skipped" | "deferred" | "failed"
  cleanupPending: boolean
  warnings: string[]
}
export type RecoveryResult = {
  generations: number
  staging: number
  trash: number
  skipped: number
  cleanupPending: boolean
  warnings: string[]
}

function registryHash(registry: string) {
  return createHash("sha256").update(canonicalRegistryFile(registry)).digest("hex")
}
function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 214 && !/[\x00-\x1f\x7f]/.test(value)
}
function validID(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && ID_PATTERN.test(value)
}

/** Host provenance only: no capability, source URL, settings, secret, or user-controlled deletion path. */
export function generationOwnership(
  registry: string,
  input: Pick<GenerationOwnership, "operationId" | "installId" | "id" | "name" | "contentHash" | "createdAt">,
): GenerationOwnership {
  if (
    !UUID.test(input.operationId) ||
    !UUID.test(input.installId) ||
    !validID(input.id) ||
    !validName(input.name) ||
    !HASH.test(input.contentHash) ||
    !validTime(input.createdAt)
  )
    throw new Error("Invalid generation ownership")
  return {
    version: 1,
    owner: OWNER,
    kind: "generation",
    registryHash: registryHash(registry),
    operationId: input.operationId,
    installId: input.installId,
    id: input.id,
    name: input.name,
    contentHash: input.contentHash,
    createdAt: input.createdAt,
  }
}

/** Write as staging/<operation UUID>/ownership.json, mode 0600, before creating any candidate content. */
export function operationOwnership(
  registry: string,
  input: Pick<OperationOwnership, "operationId" | "createdAt">,
): OperationOwnership {
  if (!UUID.test(input.operationId) || !validTime(input.createdAt)) throw new Error("Invalid operation ownership")
  return {
    version: 1,
    owner: OWNER,
    kind: "operation",
    registryHash: registryHash(registry),
    operationId: input.operationId,
    createdAt: input.createdAt,
  }
}

const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino
const ownedByHost = (stat: { uid: number }) => !process.getuid || stat.uid === process.getuid()
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"

/** Every ancestor must be a real directory. Do not accept a symlink merely because it points inside the root. */
async function directory(target: string, privateMode = false): Promise<Identity> {
  let current = target
  let result: Stats | undefined
  while (true) {
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe cleanup directory")
    if (current === target) result = stat
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  if (
    (await realpath(target)) !== target ||
    !result ||
    !ownedByHost(result) ||
    (result.mode & 0o022) !== 0 ||
    (privateMode && (result.mode & 0o777) !== 0o700)
  )
    throw new Error("Unsafe cleanup directory")
  return { dev: result.dev, ino: result.ino }
}

async function unchanged(target: string, identity: Identity, privateMode = false) {
  if (!same(await directory(target, privateMode), identity)) throw new Error("Cleanup directory changed")
}

/** Bounded, O_NOFOLLOW host metadata read; never reads operation.json (which contains a token digest). */
async function metadata(target: string): Promise<Record<string, unknown>> {
  const before = await lstat(target)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !ownedByHost(before) ||
    (before.mode & 0o777) !== 0o600 ||
    before.nlink !== 1 ||
    before.size > METADATA_LIMIT
  )
    throw new Error("Unsafe cleanup metadata")
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!same(stat, before) || !stat.isFile() || stat.size !== before.size) throw new Error("Cleanup metadata changed")
    const bytes = Buffer.alloc(METADATA_LIMIT + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await handle.stat()
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Cleanup metadata changed")
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cleanup metadata")
    return value as Record<string, unknown>
  } finally {
    await handle.close()
  }
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function baseOwnership(value: Record<string, unknown>, kind: string, hash: string, now: number) {
  return (
    value.version === 1 &&
    value.owner === OWNER &&
    value.kind === kind &&
    value.registryHash === hash &&
    typeof value.operationId === "string" &&
    UUID.test(value.operationId) &&
    validTime(value.createdAt) &&
    value.createdAt <= now
  )
}

/** Never follows a child symlink: it is unlinked, not traversed. Recheck directory inode/ancestors on each mutation. */
async function removeTree(target: string, identity: Identity) {
  let count = 0
  async function visit(current: string, expected: Identity, depth: number) {
    if (depth > 128) throw new Error("Cleanup depth limit exceeded")
    await unchanged(current, expected)
    const entries = await opendir(current)
    for await (const entry of entries) {
      if (++count > TREE_LIMIT) throw new Error("Cleanup entry limit exceeded")
      await unchanged(current, expected)
      const child = path.join(current, entry.name)
      const stat = await lstat(child)
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(child, stat, depth + 1)
      else {
        // unlink is also safe for links to directories, devices and FIFOs; it never opens their target.
        await unchanged(current, expected)
        const check = await lstat(child)
        if (!same(stat, check) || check.isDirectory()) throw new Error("Cleanup entry changed")
        await unlink(child)
      }
    }
    await unchanged(current, expected)
    await rmdir(current)
  }
  await visit(target, identity, 0)
}

function result(status: CleanupResult["status"], warning?: string): CleanupResult {
  return { status, cleanupPending: status !== "collected" && status !== "missing", warnings: warning ? [warning] : [] }
}

export function createCleanup(options: CleanupOptions) {
  const registry = canonicalRegistryFile(options.registry)
  const paths = extensionPaths(registry)
  const trash = path.join(paths.root, "trash")
  const hash = registryHash(registry)
  const now = options.now ?? Date.now

  async function withTrashClaim(id: string, run: () => Promise<CleanupResult>): Promise<CleanupResult> {
    const locks = path.join(paths.root, "cleanup-claims")
    await directory(paths.root)
    await mkdir(locks, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    await directory(locks, true)
    const claim = path.join(locks, id)
    try {
      await mkdir(claim, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return result("deferred", "This quarantine is already claimed; no stale claim is stolen")
      }
      throw error
    }
    const identity = await directory(claim, true)
    const token = randomUUID()
    const owner = path.join(claim, "owner")
    await writeClaim(owner, token)
    try {
      return await run()
    } finally {
      await unchanged(claim, identity, true)
      const handle = await open(owner, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.size !== token.length ||
          (await handle.readFile("utf8")) !== token
        ) {
          throw new Error("Cleanup claim changed")
        }
      } finally {
        await handle.close()
      }
      await unchanged(claim, identity, true)
      await unlink(owner)
      await rmdir(claim)
    }
  }

  async function storage(parent: string, target: string) {
    await directory(paths.root)
    await directory(parent, true)
    return directory(target, true)
  }
  async function moveToTrash(target: string, identity: Identity, parent: string) {
    await storage(parent, target)
    const parentIdentity = await directory(parent, true)
    await unchanged(target, identity, true)
    await mkdir(trash, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    const trashIdentity = await directory(trash, true)
    await unchanged(parent, parentIdentity, true)
    // Keep the original immutable identity so a missing source cannot hide
    // unfinished quarantine work from its operation receipt after a restart.
    const destination = path.join(trash, path.basename(target))
    await unchanged(trash, trashIdentity, true)
    try {
      await lstat(destination)
      throw new Error("Cleanup quarantine identity already exists")
    } catch (error) {
      if (!absent(error)) throw error
    }
    await unchanged(target, identity, true)
    await rename(target, destination)
    await unchanged(destination, identity, true)
    return { destination, identity }
  }
  async function finishMove(moved: { destination: string; identity: Identity }) {
    try {
      await directory(paths.root)
      await directory(trash, true)
      await options.beforeRemove?.()
      await removeTree(moved.destination, moved.identity)
      return result("collected")
    } catch {
      return result("deferred", "Owned cleanup trash was retained; deletion will require reconciliation")
    }
  }
  async function generation(installId: string): Promise<CleanupResult> {
    if (!UUID.test(installId)) return result("skipped", "Invalid generation identity was not collected")
    if (!options.references || !options.withGeneration)
      return result("deferred", "Generation collection requires live-reference and atomic registry guards")
    const target = generationPath(registry, installId)
    try {
      return await withTrashClaim(installId, async () => {
        const exclusive = await options.references!.withExclusiveGeneration(registry, installId, async () => {
          let identity: Identity
          try {
            identity = await storage(paths.packages, target)
          } catch (error) {
            if (absent(error)) {
              try {
                // Do not retry unknown trash. Its presence is enough to retain
                // this exact generation's pending receipt, not unrelated ones.
                await directory(trash, true)
                await lstat(path.join(trash, installId))
                return result("deferred", "Generation quarantine still requires reconciliation")
              } catch (quarantineError) {
                if (absent(quarantineError)) return result("missing")
                throw quarantineError
              }
            }
            throw error
          }
          const value = await metadata(path.join(target, "installation.json"))
          if (
            !exactKeys(value, [
              "version",
              "owner",
              "kind",
              "registryHash",
              "operationId",
              "installId",
              "id",
              "name",
              "contentHash",
              "createdAt",
            ]) ||
            !baseOwnership(value, "generation", hash, now()) ||
            value.installId !== installId ||
            !validID(value.id) ||
            !validName(value.name) ||
            typeof value.contentHash !== "string" ||
            !HASH.test(value.contentHash)
          )
            return result("skipped", "Unknown generation ownership was preserved")
          // A generation lease excludes active installers/runtimes; the registry guard closes reference-check/CAS races.
          const claim = await options.withGeneration!(installId, async () => {
            await unchanged(target, identity, true)
            const current = await metadata(path.join(target, "installation.json"))
            if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error("Generation ownership changed")
            return moveToTrash(target, identity, paths.packages)
          })
          if (!claim.collected || !claim.value) return result("deferred", "Referenced generation was preserved")
          return { destination: claim.value.destination, identity: claim.value.identity }
        })
        if (exclusive.status === "busy")
          return result("deferred", "Generation is live or its liveness could not be proven")
        const outcome = exclusive.value
        return "destination" in outcome ? await finishMove(outcome) : outcome
      })
    } catch {
      return result("skipped", "Generation ownership or filesystem validation failed; files were preserved")
    }
  }

  async function recoverOperation(operationId: string): Promise<CleanupResult> {
    if (!options.references) return result("deferred", "Operation cleanup requires an OS-backed operation lease guard")
    try {
      return await withTrashClaim(operationId, async () => {
        const exclusive = await options.references!.withExclusiveOperation(registry, operationId, async () => {
          const target = path.join(paths.staging, operationId)
          const identity = await storage(paths.staging, target)
          const value = await metadata(path.join(target, "ownership.json"))
          if (
            !exactKeys(value, ["version", "owner", "kind", "registryHash", "operationId", "createdAt"]) ||
            !baseOwnership(value, "operation", hash, now()) ||
            value.operationId !== operationId
          )
            return result("skipped", "Unknown operation ownership was preserved")
          // OS exclusivity, not expiration/PID/TTL, proves the old worker cannot still promote this candidate.
          // No receipt, installed generation or registry record is modified. Durable committed receipts survive.
          return moveToTrash(target, identity, paths.staging)
        })
        if (exclusive.status === "busy")
          return result("deferred", "Operation worker is live or its liveness could not be proven")
        const outcome = exclusive.value
        return "destination" in outcome ? await finishMove(outcome) : outcome
      })
    } catch {
      return result("skipped", "Operation ownership or filesystem validation failed; files were preserved")
    }
  }

  async function scan(
    parent: string,
    visit: (id: string) => Promise<CleanupResult>,
    report: RecoveryResult,
    kind: "generations" | "staging" | "trash",
    budget: { remaining: number },
  ) {
    try {
      await directory(paths.root)
      await directory(parent, true)
      const entries = await opendir(parent)
      for await (const entry of entries) {
        if (budget.remaining-- <= 0) {
          report.cleanupPending = true
          report.warnings.push("Cleanup scan limit reached; remaining entries were preserved")
          break
        }
        if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
          report.skipped++
          report.cleanupPending = true
          continue
        }
        const outcome = await visit(entry.name)
        if (outcome.status === "collected") report[kind]++
        else if (outcome.status !== "missing") report.skipped++
        report.cleanupPending ||= outcome.cleanupPending
        for (const warning of outcome.warnings) if (!report.warnings.includes(warning)) report.warnings.push(warning)
      }
    } catch (error) {
      if (absent(error)) return
      report.cleanupPending = true
      report.warnings.push("Cleanup scan failed validation; storage was preserved")
    }
  }

  return {
    collectGeneration: generation,
    async recover(): Promise<RecoveryResult> {
      const report: RecoveryResult = {
        generations: 0,
        staging: 0,
        trash: 0,
        skipped: 0,
        cleanupPending: false,
        warnings: [],
      }
      // Stage first: a worker must release its operation lease only after releasing all generation leases.
      const budget = { remaining: SCAN_LIMIT }
      await scan(paths.staging, recoverOperation, report, "staging", budget)
      await scan(paths.packages, generation, report, "generations", budget)
      // A crash after quarantine must not be reported as completed cleanup. Old trash without a durable
      // quarantine claim cannot be safely attributed or retried, so report it rather than guessing ownership.
      await scan(
        trash,
        async () => result("deferred", "Private cleanup trash requires reconciliation; files were preserved"),
        report,
        "trash",
        budget,
      )
      return report
    },
    async purge(id: string, expectedRetainedRevision: number): Promise<CleanupResult> {
      if (!validID(id) || !Number.isSafeInteger(expectedRetainedRevision) || expectedRetainedRevision < 0)
        return result("skipped", "Invalid retained-data identity was not purged")
      // P2 data/cache directories have no trusted host ownership records. Never claim the tombstone until
      // a host helper can validate both exact Global namespaces and rename without traversing any links.
      if (!options.withPurge || !options.renameRetainedData)
        return result(
          "deferred",
          "Data purge requires an atomic retained-data claim and trusted data/cache ownership records",
        )
      try {
        const claim = await options.withPurge(id, expectedRetainedRevision, async (identity) => {
          if (identity.revision !== expectedRetainedRevision || !validName(identity.name))
            throw new Error("Retained-data identity changed")
          return options.renameRetainedData!({
            id,
            name: identity.name,
            source: identity.source,
            revision: identity.revision,
          })
        })
        if (!claim.purged)
          return result("deferred", "Retained-data claim was not acquired; data and settings were preserved")
        // Missing callback output is not proof that filesystem ownership validation and renames ran.
        if (!claim.value || typeof claim.value.cleanupPending !== "boolean")
          return result("deferred", "Purge outcome is unconfirmed; reconciliation is required")
        return {
          status: "collected",
          cleanupPending: claim.value.cleanupPending,
          warnings: claim.value.cleanupPending ? ["Data purge committed; private trash deletion is pending"] : [],
        }
      } catch {
        return result("deferred", "Data purge was not confirmed; retained-data intent and files require reconciliation")
      }
    },
  }
}
