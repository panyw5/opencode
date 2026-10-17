import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { ExtensionLeases } from "../../src/extension/leases"
import {
  createCleanup,
  generationOwnership,
  operationOwnership,
  type CleanupOptions,
  type CleanupReferences,
} from "../../src/extension/cleanup"

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})
const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  )

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-cleanup-")))
  roots.push(root)
  await chmod(root, 0o700)
  const registry = path.join(root, "registry.json")
  const packages = path.join(root, "packages")
  const staging = path.join(root, "staging")
  await mkdir(packages, { mode: 0o700 })
  await mkdir(staging, { mode: 0o700 })
  const referenced = new Set<string>()
  const liveGenerations = new Set<string>()
  const liveOperations = new Set<string>()
  const calls: string[] = []
  const references: CleanupReferences = {
    async withExclusiveGeneration(_registry, id, fn) {
      calls.push(`generation:${id}`)
      if (liveGenerations.has(id)) return { status: "busy", reason: "live" }
      return { status: "collected", value: await fn() }
    },
    async withExclusiveOperation(_registry, id, fn) {
      calls.push(`operation:${id}`)
      if (liveOperations.has(id)) return { status: "busy", reason: "live" }
      return { status: "collected", value: await fn() }
    },
  }
  const withGeneration: NonNullable<CleanupOptions["withGeneration"]> = async (id, fn) => {
    calls.push(`registry:${id}`)
    return referenced.has(id) ? { collected: false } : { collected: true, value: await fn() }
  }
  const options = { registry, references, withGeneration, now: () => 1000 }
  async function generation(input: { installId?: string; operationId?: string } = {}) {
    const installId = input.installId ?? randomUUID()
    const operationId = input.operationId ?? randomUUID()
    const directory = path.join(packages, installId)
    await mkdir(directory, { mode: 0o700 })
    await mkdir(path.join(directory, "package"), { mode: 0o700 })
    await writeFile(path.join(directory, "package", "content"), "extension bytes")
    const owner = generationOwnership(registry, {
      installId,
      operationId,
      id: "test.extension",
      name: "test-extension",
      contentHash: "a".repeat(64),
      createdAt: 100,
    })
    await writeFile(path.join(directory, "installation.json"), JSON.stringify(owner), { mode: 0o600 })
    return { installId, operationId, directory, owner }
  }
  async function operation(operationId = randomUUID()) {
    const directory = path.join(staging, operationId)
    await mkdir(directory, { mode: 0o700 })
    await writeFile(
      path.join(directory, "ownership.json"),
      JSON.stringify(operationOwnership(registry, { operationId, createdAt: 100 })),
      { mode: 0o600 },
    )
    // Recovery must not open this secret-bearing journal, including when it is malformed or points outside storage.
    await writeFile(path.join(directory, "operation.json"), "{invalid secret tokenHash}", { mode: 0o600 })
    return { operationId, directory }
  }
  return {
    root,
    registry,
    packages,
    staging,
    referenced,
    liveGenerations,
    liveOperations,
    calls,
    options,
    generation,
    operation,
  }
}

describe("extension safe cleanup", () => {
  test("collects only owned unreferenced generations through both guards", async () => {
    const f = await fixture()
    const g = await f.generation()
    const output = await createCleanup(f.options).collectGeneration(g.installId)
    expect(output).toEqual({ status: "collected", cleanupPending: false, warnings: [] })
    expect(await exists(g.directory)).toBe(false)
    expect(f.calls).toEqual([`generation:${g.installId}`, `registry:${g.installId}`])
    expect(await readdir(path.join(f.root, "trash"))).toEqual([])
    expect((await lstat(path.join(f.root, "trash"))).mode & 0o777).toBe(0o700)
  })

  test("an existing quarantine identity is never replaced by another collection", async () => {
    const f = await fixture()
    const g = await f.generation()
    const destination = path.join(f.root, "trash", g.installId)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    expect((await createCleanup(f.options).collectGeneration(g.installId)).cleanupPending).toBe(true)
    expect(await readFile(path.join(g.directory, "package", "content"), "utf8")).toBe("extension bytes")
    expect(await readdir(destination)).toEqual([])
  })

  test("referenced, live, and unprovable generations remain intact", async () => {
    const f = await fixture()
    const a = await f.generation()
    const b = await f.generation()
    f.referenced.add(a.installId)
    f.liveGenerations.add(b.installId)
    expect((await createCleanup(f.options).collectGeneration(a.installId)).status).toBe("deferred")
    expect((await createCleanup(f.options).collectGeneration(b.installId)).status).toBe("deferred")
    expect((await createCleanup({ registry: f.registry }).collectGeneration(a.installId)).status).toBe("deferred")
    expect(
      (await createCleanup({ ...f.options, withGeneration: undefined }).collectGeneration(a.installId)).status,
    ).toBe("deferred")
    expect(await exists(a.directory)).toBe(true)
    expect(await exists(b.directory)).toBe(true)
    expect(f.calls).not.toContain(`registry:${b.installId}`)
  })

  test("atomic registry claim rechecks a reference acquired after OS guard", async () => {
    const f = await fixture()
    const g = await f.generation()
    const cleanup = createCleanup({
      ...f.options,
      withGeneration: async (id) => {
        f.referenced.add(id)
        return { collected: false }
      },
    })
    expect((await cleanup.collectGeneration(g.installId)).status).toBe("deferred")
    expect(await readFile(path.join(g.directory, "package", "content"), "utf8")).toBe("extension bytes")
  })

  test("restart before promotion removes only a dead owned stage without reading its secret journal", async () => {
    const f = await fixture()
    const stage = await f.operation()
    await mkdir(path.join(stage.directory, "package"), { mode: 0o700 })
    await writeFile(path.join(stage.directory, "package", "content"), "candidate")
    const output = await createCleanup(f.options).recover()
    expect(output.staging).toBe(1)
    expect(output.generations).toBe(0)
    expect(output.cleanupPending).toBe(false)
    expect(JSON.stringify(output)).not.toContain("tokenHash")
    expect(await exists(stage.directory)).toBe(false)
  })

  test("restart after promotion preserves committed generations and receipt bytes", async () => {
    const f = await fixture()
    const stage = await f.operation()
    const g = await f.generation({ operationId: stage.operationId })
    f.referenced.add(g.installId)
    const durable = JSON.stringify({
      receipts: { [stage.operationId]: { tokenHash: "DO-NOT-READ", installId: g.installId } },
    })
    await writeFile(f.registry, durable, { mode: 0o600 })
    const output = await createCleanup(f.options).recover()
    expect(output.staging).toBe(1)
    expect(output.generations).toBe(0)
    expect(await exists(stage.directory)).toBe(false)
    expect(await exists(g.directory)).toBe(true)
    expect(await readFile(f.registry, "utf8")).toBe(durable)
    expect(JSON.stringify(output)).not.toContain("DO-NOT-READ")
  })

  test("restart after uncommitted promotion collects the orphan generation", async () => {
    const f = await fixture()
    const stage = await f.operation()
    const g = await f.generation({ operationId: stage.operationId })
    const output = await createCleanup(f.options).recover()
    expect(output.staging).toBe(1)
    expect(output.generations).toBe(1)
    expect(output.cleanupPending).toBe(false)
    expect(await exists(g.directory)).toBe(false)
  })

  test("expired preparation is never proof of a dead worker", async () => {
    const f = await fixture()
    const stage = await f.operation()
    f.liveOperations.add(stage.operationId)
    await writeFile(path.join(stage.directory, "operation.json"), JSON.stringify({ expiresAt: 0, state: "prepared" }))
    const output = await createCleanup({ ...f.options, now: () => 999999999999 }).recover()
    expect(output.staging).toBe(0)
    expect(output.cleanupPending).toBe(true)
    expect(await exists(stage.directory)).toBe(true)
  })

  test("missing, corrupt, foreign and future ownership records are preserved", async () => {
    for (const mutate of [
      async (g: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["generation"]>>) =>
        rm(path.join(g.directory, "installation.json")),
      async (g: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["generation"]>>) =>
        writeFile(path.join(g.directory, "installation.json"), "{"),
      async (g: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["generation"]>>) =>
        writeFile(
          path.join(g.directory, "installation.json"),
          JSON.stringify({ ...g.owner, registryHash: "b".repeat(64) }),
        ),
      async (g: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["generation"]>>) =>
        writeFile(path.join(g.directory, "installation.json"), JSON.stringify({ ...g.owner, createdAt: 1001 })),
      async (g: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["generation"]>>) =>
        writeFile(path.join(g.directory, "installation.json"), JSON.stringify({ ...g.owner, directory: "/outside" })),
      async (g: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["generation"]>>) =>
        chmod(path.join(g.directory, "installation.json"), 0o644),
    ]) {
      const f = await fixture()
      const g = await f.generation()
      await mutate(g)
      expect((await createCleanup(f.options).collectGeneration(g.installId)).status).toBe("skipped")
      expect(await exists(g.directory)).toBe(true)
    }
  })

  test("symlink generation root, parent and metadata never delete external content", async () => {
    for (const mode of ["root", "parent", "metadata"] as const) {
      const f = await fixture()
      const external = path.join(f.root, "outside")
      await mkdir(external, { mode: 0o700 })
      await writeFile(path.join(external, "precious"), "untouched")
      const g = await f.generation()
      if (mode === "root") {
        await rm(g.directory, { recursive: true })
        await symlink(external, g.directory)
      } else if (mode === "parent") {
        await rm(f.packages, { recursive: true })
        await symlink(external, f.packages)
      } else {
        await rm(path.join(g.directory, "installation.json"))
        await symlink(path.join(external, "precious"), path.join(g.directory, "installation.json"))
      }
      expect((await createCleanup(f.options).collectGeneration(g.installId)).status).toBe("skipped")
      expect(await readFile(path.join(external, "precious"), "utf8")).toBe("untouched")
    }
  })

  test("child symlinks are unlinked without traversing their external target", async () => {
    const f = await fixture()
    const g = await f.generation()
    const external = path.join(f.root, "outside")
    await mkdir(external, { mode: 0o700 })
    await writeFile(path.join(external, "precious"), "untouched")
    await symlink(external, path.join(g.directory, "package", "link"))
    expect((await createCleanup(f.options).collectGeneration(g.installId)).status).toBe("collected")
    expect(await readFile(path.join(external, "precious"), "utf8")).toBe("untouched")
  })

  test("unknown, non-private, and non-UUID storage remains untouched", async () => {
    const f = await fixture()
    const stage = await f.operation()
    await rm(path.join(stage.directory, "ownership.json"))
    const g = await f.generation()
    await chmod(g.directory, 0o755)
    const unknown = path.join(f.packages, "unknown")
    await mkdir(unknown, { mode: 0o700 })
    const output = await createCleanup(f.options).recover()
    expect(output.cleanupPending).toBe(true)
    expect(output.generations).toBe(0)
    expect(output.staging).toBe(0)
    expect(await exists(unknown)).toBe(true)
    expect(await exists(g.directory)).toBe(true)
    expect(await exists(stage.directory)).toBe(true)
  })

  test("scan processes at most 1000 entries across namespaces", async () => {
    const f = await fixture()
    for (let i = 0; i < 1001; i++) await mkdir(path.join(f.staging, `unknown-${i}`), { mode: 0o700 })
    const g = await f.generation()
    const output = await createCleanup(f.options).recover()
    expect(output.skipped).toBe(1000)
    expect(output.cleanupPending).toBe(true)
    expect(output.warnings.join(" ")).toContain("scan limit")
    expect(await exists(g.directory)).toBe(true)
    expect(f.calls).toEqual([])
  })

  test("purge remains explicitly deferred without trusted data/cache ownership and does not claim settings", async () => {
    const f = await fixture()
    let claimed = false
    const cleanup = createCleanup({
      ...f.options,
      withPurge: async () => {
        claimed = true
        return { purged: true }
      },
    })
    expect((await cleanup.purge("test.extension", 3)).status).toBe("deferred")
    expect((await cleanup.purge("../outside", 3)).status).toBe("skipped")
    expect((await cleanup.purge("test.extension", -1)).status).toBe("skipped")
    expect(claimed).toBe(false)
  })

  test("purge runs trusted filesystem renames inside the atomic retained-revision guard", async () => {
    const f = await fixture()
    const order: string[] = []
    const output = await createCleanup({
      ...f.options,
      withPurge: async (id, revision, fn) => {
        expect(id).toBe("test.extension")
        expect(revision).toBe(7)
        order.push("guard")
        const value = await fn({
          name: "test-extension",
          source: { type: "archive", location: "https://example.test/pkg", sha256: "a".repeat(64) },
          revision,
        })
        order.push("committed")
        return { purged: true, value }
      },
      renameRetainedData: async (identity) => {
        expect(identity.id).toBe("test.extension")
        expect(identity.revision).toBe(7)
        order.push("rename")
        return { cleanupPending: true }
      },
    }).purge("test.extension", 7)
    expect(order).toEqual(["guard", "rename", "committed"])
    expect(output.status).toBe("collected")
    expect(output.cleanupPending).toBe(true)
  })

  test("purge conflicts and failed ownership validation never report success", async () => {
    const f = await fixture()
    const renameRetainedData = async () => {
      throw new Error("secret external directory")
    }
    const cleanup = createCleanup({
      ...f.options,
      withPurge: async (_id, revision, fn) => ({
        purged: true,
        value: await fn({ name: "test-extension", source: { type: "path", path: "/outside" }, revision }),
      }),
      renameRetainedData,
    })
    const output = await cleanup.purge("test.extension", 7)
    expect(output.status).toBe("deferred")
    expect(JSON.stringify(output)).not.toContain("secret")
    expect(
      (
        await createCleanup({ ...f.options, renameRetainedData, withPurge: async () => ({ purged: false }) }).purge(
          "test.extension",
          7,
        )
      ).status,
    ).toBe("deferred")
  })

  test("leftover quarantine is reported pending, not deleted on guessed ownership", async () => {
    const f = await fixture()
    const trash = path.join(f.root, "trash")
    const residual = path.join(trash, randomUUID())
    await mkdir(trash, { mode: 0o700 })
    await mkdir(residual, { mode: 0o700 })
    await writeFile(path.join(residual, "precious"), "untouched")
    const output = await createCleanup(f.options).recover()
    expect(output.cleanupPending).toBe(true)
    expect(output.trash).toBe(0)
    expect(output.warnings.join(" ")).toContain("trash")
    expect(await readFile(path.join(residual, "precious"), "utf8")).toBe("untouched")
  })

  test("registry parent may be owner-only writable 0755 without changing its permissions", async () => {
    const f = await fixture()
    const g = await f.generation()
    await chmod(f.root, 0o755)
    expect((await createCleanup(f.options).collectGeneration(g.installId)).status).toBe("collected")
    expect((await lstat(f.root)).mode & 0o777).toBe(0o755)
  })

  test("metadata helpers discard extra secret-bearing fields", async () => {
    const f = await fixture()
    const operationId = randomUUID()
    const output = operationOwnership(f.registry, { operationId, createdAt: 0, secret: "not-persisted" } as never)
    expect(Object.keys(output).sort()).toEqual(["createdAt", "kind", "operationId", "owner", "registryHash", "version"])
    expect(JSON.stringify(output)).not.toContain("not-persisted")
    expect((await createCleanup(f.options).collectGeneration("../../outside")).status).toBe("skipped")
  })
})

for (const kind of ["generation", "operation"] as const) {
  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    `${kind} slow deletion releases namespace gate but keeps exact quarantine exclusive`,
    async () => {
      const f = await fixture()
      const g = kind === "generation" ? await f.generation() : await f.operation()
      const id = "installId" in g ? g.installId : g.operationId
      const acquire = kind === "generation" ? ExtensionLeases.acquire : ExtensionLeases.acquireOperation
      await (await acquire(f.registry, id)).release()
      const unrelated = randomUUID()
      let enter!: () => void
      let leave!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const paused = new Promise<void>((resolve) => {
        leave = resolve
      })
      const cleanup = createCleanup({
        ...f.options,
        references: ExtensionLeases,
        beforeRemove: async () => {
          enter()
          await paused
        },
      })
      const running = kind === "generation" ? cleanup.collectGeneration(id) : cleanup.recover()
      const timer = setTimeout(() => {
        leave()
      }, 5000)
      let reference: Awaited<ReturnType<typeof acquire>> | undefined
      try {
        await entered
        reference = await acquire(f.registry, unrelated)
        expect(reference.proof).toBe("flock")
        const duplicate = createCleanup({ ...f.options, references: ExtensionLeases })
        if (kind === "generation") {
          expect((await duplicate.collectGeneration(id)).cleanupPending).toBe(true)
        } else {
          expect((await duplicate.recover()).cleanupPending).toBe(true)
        }
        expect(await exists(path.join(f.root, "trash", id))).toBe(true)
      } finally {
        clearTimeout(timer)
        leave()
        await reference?.release()
      }
      const completed = await running
      expect(completed.cleanupPending).toBe(false)
      expect(await exists(path.join(f.root, "trash", id))).toBe(false)
    },
    15000,
  )
}

test("a crashed exact quarantine claim is never reclaimed by age", async () => {
  const f = await fixture()
  const g = await f.generation()
  const claim = path.join(f.root, "cleanup-claims", g.installId)
  await mkdir(claim, { recursive: true, mode: 0o700 })
  await writeFile(path.join(claim, "owner"), "old process claim", { mode: 0o600 })
  const output = await createCleanup(f.options).collectGeneration(g.installId)
  expect(output.cleanupPending).toBe(true)
  expect(await exists(g.directory)).toBe(true)
  expect(f.calls).toEqual([])
})
