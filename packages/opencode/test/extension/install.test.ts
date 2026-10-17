import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import tar from "tar-stream"
import { createInstaller, type InstallerOptions } from "../../src/extension/install"
import * as Registry from "../../src/extension/registry"
import { ExtensionID } from "../../src/extension/schema"
import { resolveNpm } from "../../src/extension/npm"
import { ExtensionLeases } from "../../src/extension/leases"

const roots: string[] = []
const installers: ReturnType<typeof createInstaller>[] = []
afterEach(async () => {
  await Promise.all(installers.splice(0).map((installer) => installer.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const id = ExtensionID.make("test.extension")
const sha = (input: Uint8Array) => createHash("sha256").update(input).digest("hex")
async function fixture(version = "1.0.0", extra: Record<string, string> = {}, permissions: string[] = []) {
  const pkg = {
    name: "test-extension",
    version,
    exports: { "./web": "./web.js", "./server": "./server.js" },
    opencode: {
      manifestVersion: 1,
      id: "test.extension",
      displayName: "Fixture",
      web: { apiVersion: 1 },
      permissions,
      contributes: { settings: { apiKey: { type: "string", title: "Key", secret: true } } },
    },
  }
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const completed = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.from(chunk))
  })()
  for (const [name, content] of Object.entries({
    "package.json": JSON.stringify(pkg),
    "web.js": "throw new Error('extension must not execute during installation')",
    "server.js": "throw new Error('extension must not execute during installation')",
    ...extra,
  })) {
    pack.entry({ name: `package/${name}`, mode: 0o777 }, content)
  }
  pack.finalize()
  await completed
  return { bytes: gzipSync(Buffer.concat(chunks)), pkg }
}
async function setup(options: InstallerOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-install-")))
  roots.push(root)
  const registry = path.join(root, "registry.json")
  const installer = createInstaller({ registry, ...options })
  installers.push(installer)
  async function archive(version = "1.0.0", extra: Record<string, string> = {}, permissions: string[] = []) {
    const { bytes } = await fixture(version, extra, permissions)
    const file = path.join(root, `fixture-${version}.tgz`)
    await writeFile(file, bytes)
    return { type: "local" as const, path: file, sha256: sha(bytes) }
  }
  return { root, registry, installer, archive }
}

async function install(context: Awaited<ReturnType<typeof setup>>, version = "1.0.0", enable?: boolean) {
  const prepared = await context.installer.prepare({ kind: "install", source: await context.archive(version) })
  const result = await context.installer.commit(prepared.operationId, prepared.token, { enable })
  expect(result.committed).toBe(true)
  return prepared
}

describe("extension installation transactions", () => {
  test("offline local tgz is previewed without executing entries; defaults disabled and has atomic receipt", async () => {
    const context = await setup()
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    expect(prepared.enable).toBe(false)
    expect(prepared.hasServer).toBe(true)
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    const metadata = await readFile(path.join(context.root, "staging", prepared.operationId, "operation.json"), "utf8")
    expect(metadata).not.toContain(prepared.token)
    expect((await stat(path.join(context.root, "staging", prepared.operationId, "operation.json"))).mode & 0o777).toBe(
      0o600,
    )
    const result = await context.installer.commit(prepared.operationId, prepared.token)
    expect(result).toMatchObject({ committed: true, synced: false, cleanupPending: true })
    expect(result.warnings.length).toBeGreaterThan(0)
    const store = JSON.parse(await readFile(context.registry, "utf8"))
    expect(store.extensions[id].enabled).toBe(false)
    expect(store.extensions[id].installId).toBe(prepared.installId)
    expect(store.receipts[prepared.operationId].installId).toBe(prepared.installId)
    expect(store.receipts[prepared.operationId].tokenHash).not.toBe(prepared.token)
    expect(await context.installer.commit(prepared.operationId, prepared.token)).toEqual(result)
    expect(JSON.stringify(await context.installer.status(prepared.operationId, prepared.token))).not.toContain(
      prepared.token,
    )
  })

  test("all methods authenticate capabilities; no secret settings in preview/status", async () => {
    const context = await setup()
    const prepared = await install(context)
    await Registry.updateSettings(id, { apiKey: "DO_NOT_DISCLOSE" }, undefined, context.registry)
    const remove = await context.installer.prepare({ kind: "uninstall", id })
    expect(JSON.stringify(remove)).not.toContain("DO_NOT_DISCLOSE")
    for (const action of [context.installer.status, context.installer.cancel, context.installer.commit]) {
      await expect(action(remove.operationId, "bad-token")).rejects.toThrow("capability")
      await expect(action(prepared.operationId, "bad-token")).rejects.toThrow("capability")
    }
    expect(JSON.stringify(await context.installer.status(remove.operationId, remove.token))).not.toContain(
      "DO_NOT_DISCLOSE",
    )
  })

  test("cancel is serialized with commit and no registry pointer is published", async () => {
    const context = await setup()
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    const [cancelled, committed] = await Promise.all([
      context.installer.cancel(prepared.operationId, prepared.token),
      context.installer.commit(prepared.operationId, prepared.token),
    ])
    expect(cancelled.state).toBe("cancelled")
    expect(committed.state).toBe("cancelled")
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
  })

  test("TTL invalidates prepared operations and cleans only their staging directory", async () => {
    let clock = 1000
    const context = await setup({ now: () => clock })
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    clock += 10 * 60 * 1000
    expect((await context.installer.commit(prepared.operationId, prepared.token)).state).toBe("expired")
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
  })

  test("whole-tree digest detects changes to a file not mentioned in the manifest", async () => {
    const context = await setup()
    const prepared = await context.installer.prepare({
      kind: "install",
      source: await context.archive("1.0.0", { "unused.js": "original" }),
    })
    await writeFile(path.join(context.root, "staging", prepared.operationId, "package", "unused.js"), "changed")
    await expect(context.installer.commit(prepared.operationId, prepared.token)).rejects.toThrow("content changed")
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
  })

  test("two same-id operations race through CAS; loser cannot remove winner generation", async () => {
    const context = await setup()
    const source = await context.archive()
    const a = await context.installer.prepare({ kind: "install", source })
    const b = await context.installer.prepare({ kind: "install", source })
    const result = await Promise.allSettled([
      context.installer.commit(a.operationId, a.token),
      context.installer.commit(b.operationId, b.token),
    ])
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1)
    const row = (await Registry.snapshot(id, context.registry)).row!
    expect(await readFile(path.join(row.dir, "package.json"), "utf8")).toContain("test-extension")
    expect(await readdir(path.join(context.root, "packages"))).toEqual([row.installId!])
  })

  test("update preserves enabled/settings/installedAt and rejects concurrent settings writes", async () => {
    const context = await setup()
    await install(context, "1.0.0", true)
    await Registry.updateSettings(id, { apiKey: "STORED_PRIVATE_VALUE" }, undefined, context.registry)
    const before = (await Registry.snapshot(id, context.registry)).row!
    // Same archive location is the source identity; overwrite the local file with a newer version.
    const bytes = (await fixture("2.0.0")).bytes
    const location = before.source.type === "archive" ? before.source.location : ""
    await writeFile(location, bytes)
    const update = await context.installer.prepare({
      kind: "update",
      id,
      source: { type: "local", path: location, sha256: sha(bytes) },
    })
    expect(JSON.stringify(update)).not.toContain("STORED_PRIVATE_VALUE")
    const result = await context.installer.commit(update.operationId, update.token, { enable: false })
    expect(result.committed).toBe(true)
    const after = (await Registry.snapshot(id, context.registry)).row!
    expect(after).toMatchObject({
      enabled: true,
      settings: { apiKey: "STORED_PRIVATE_VALUE" },
      installedAt: before.installedAt,
      version: "2.0.0",
    })
    expect(after.installId).not.toBe(before.installId)
    expect(await stat(before.dir)).toBeDefined()
    const newer = (await fixture("3.0.0")).bytes
    await writeFile(location, newer)
    const stale = await context.installer.prepare({
      kind: "update",
      id,
      source: { type: "local", path: location, sha256: sha(newer) },
    })
    await Registry.updateSettings(id, { apiKey: "concurrent" }, undefined, context.registry)
    await expect(context.installer.commit(stale.operationId, stale.token)).rejects.toThrow("changed")
    expect((await Registry.snapshot(id, context.registry)).row!.settings).toEqual({ apiKey: "concurrent" })
  })

  test("uninstall preserves live generation and data; purge explicitly deferred", async () => {
    const context = await setup()
    await install(context)
    await Registry.updateSettings(id, { apiKey: "keep" }, undefined, context.registry)
    const previous = (await Registry.snapshot(id, context.registry)).row!
    const prepared = await context.installer.prepare({ kind: "uninstall", id, purgeData: true })
    const result = await context.installer.commit(prepared.operationId, prepared.token)
    expect(result).toMatchObject({ committed: true, cleanupPending: true, synced: false })
    expect(result.warnings.join(" ")).toContain("purge is deferred")
    expect(await stat(previous.dir)).toBeDefined()
    const snapshot = await Registry.snapshot(id, context.registry)
    expect(snapshot.row).toBeUndefined()
    expect(snapshot.retained!.settings).toEqual({ apiKey: "keep" })
    expect(await context.installer.cancel(prepared.operationId, prepared.token)).toEqual(result)
  })

  test("coordinator failure cannot turn a committed installation into rollback", async () => {
    const context = await setup({
      coordinate: async () => {
        throw new Error("private coordination detail")
      },
    })
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    const result = await context.installer.commit(prepared.operationId, prepared.token)
    expect(result).toMatchObject({ committed: true, synced: false })
    expect(JSON.stringify(result)).not.toContain("private coordination detail")
    expect((await Registry.snapshot(id, context.registry)).row).toBeDefined()
    expect(await context.installer.commit(prepared.operationId, prepared.token)).toEqual(result)
  })

  test("restart loses prepared tokens but recovers authenticated safe committed receipts", async () => {
    const context = await setup()
    const prepared = await install(context)
    const next = createInstaller({ registry: context.registry })
    expect(await next.status(prepared.operationId, prepared.token)).toMatchObject({ committed: true, synced: false })
    await expect(next.status(prepared.operationId, "wrong")).rejects.toThrow("capability")
    const uninstall = await context.installer.prepare({ kind: "uninstall", id })
    await expect(next.commit(uninstall.operationId, uninstall.token)).rejects.toThrow("capability")
  })

  test("caps active operations at four and expired operations release capacity", async () => {
    let clock = 100
    const context = await setup({ now: () => clock })
    const source = await context.archive()
    const prepared = []
    for (let index = 0; index < 4; index++) prepared.push(await context.installer.prepare({ kind: "install", source }))
    await expect(context.installer.prepare({ kind: "install", source })).rejects.toThrow("Too many")
    clock += 600001
    expect((await context.installer.prepare({ kind: "install", source })).operationId).toBeDefined()
  })

  test("archive integrity and extraction failures publish no registry row or generation", async () => {
    const context = await setup()
    const source = await context.archive()
    await expect(
      context.installer.prepare({ kind: "install", source: { ...source, sha256: "0".repeat(64) } }),
    ).rejects.toThrow()
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
    const throwing = createInstaller({
      registry: context.registry,
      extract: async () => {
        throw new Error("extract failure")
      },
    })
    await expect(throwing.prepare({ kind: "install", source })).rejects.toThrow("preparation failed")
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
  })

  test("npm root and full graph use the original prepared object and real offline tgz payload", async () => {
    const { bytes, pkg } = await fixture()
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    const metadata = {
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg,
          dist: { integrity, tarball: "https://registry.npmjs.org/test-extension/-/test-extension-1.0.0.tgz" },
        },
      },
    }
    let downloads = 0
    const context = await setup({
      resolveNpm: (spec, options) => resolveNpm(spec, { ...options, transport: async () => metadata }),
      download: async () => {
        downloads++
        return bytes
      },
    })
    const prepared = await context.installer.prepare({
      kind: "install",
      source: { type: "npm", spec: "test-extension@1.0.0" },
    })
    const result = await context.installer.commit(prepared.operationId, prepared.token)
    expect(result.committed).toBe(true)
    expect(downloads).toBe(2)
    const row = (await Registry.snapshot(id, context.registry)).row!
    expect(row.source.type).toBe("npm")
    expect(await stat(path.join(path.dirname(row.dir), "npm-lock.json"))).toBeDefined()
  })

  test("absent-row ABA is rejected using the retained-data revision", async () => {
    const context = await setup()
    const source = await context.archive()
    const stale = await context.installer.prepare({ kind: "install", source })
    const other = createInstaller({ registry: context.registry })
    const installed = await other.prepare({ kind: "install", source })
    await other.commit(installed.operationId, installed.token)
    const removal = await other.prepare({ kind: "uninstall", id })
    await other.commit(removal.operationId, removal.token)
    await expect(context.installer.commit(stale.operationId, stale.token)).rejects.toThrow("changed")
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
  })

  test("materialization failure cleans only its uncommitted generation", async () => {
    const { bytes, pkg } = await fixture()
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    const metadata = {
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg,
          dist: { integrity, tarball: "https://registry.npmjs.org/test-extension/-/test-extension-1.0.0.tgz" },
        },
      },
    }
    let acquired = 0
    const context = await setup({
      beforeCoordinate: async () => {
        acquired++
        return () => {}
      },
      resolveNpm: (spec, options) => resolveNpm(spec, { ...options, transport: async () => metadata }),
      download: async () => bytes,
      materializeNpm: async () => {
        throw new Error("materialization failure")
      },
    })
    const prepared = await context.installer.prepare({
      kind: "install",
      source: { type: "npm", spec: "test-extension@1.0.0" },
    })
    await expect(context.installer.commit(prepared.operationId, prepared.token)).rejects.toThrow("commit failed")
    expect(acquired).toBe(0)
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect(await readdir(path.join(context.root, "packages"))).toEqual([])
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
  })

  test("commit wins a concurrent cancel and coordinator receives the persisted row", async () => {
    let coordinated = false
    const context = await setup({
      coordinate: async ({ row }) => {
        expect(row?.revision).toBeGreaterThan(0)
        coordinated = true
        return { synced: true }
      },
    })
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    const [committed, cancelled] = await Promise.all([
      context.installer.commit(prepared.operationId, prepared.token),
      context.installer.cancel(prepared.operationId, prepared.token),
    ])
    expect(committed).toMatchObject({ committed: true, synced: true, cleanupPending: true })
    expect(cancelled).toEqual(committed)
    expect(coordinated).toBe(true)
  })

  test("lifecycle fence covers commit, postcommit coordination and staging cleanup before release", async () => {
    let active = false
    let released = 0
    let registry = ""
    let root = ""
    let operationId = ""
    const context = await setup({
      beforeCoordinate: async (input) => {
        expect(input).toMatchObject({ id, kind: "install" })
        expect((await Registry.snapshot(id, registry)).row).toBeUndefined()
        active = true
        return async () => {
          expect(active).toBe(true)
          expect((await Registry.snapshot(id, registry)).row).toBeDefined()
          expect(await readdir(path.join(root, "staging"))).not.toContain(operationId)
          active = false
          released++
        }
      },
      coordinate: async () => {
        expect(active).toBe(true)
        return { synced: true }
      },
    })
    registry = context.registry
    root = context.root
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    operationId = prepared.operationId
    const result = await context.installer.commit(operationId, prepared.token)
    expect(result).toMatchObject({ committed: true, synced: true })
    expect(active).toBe(false)
    expect(released).toBe(1)
    await context.installer.commit(operationId, prepared.token)
    expect(released).toBe(1)
  })

  test("fence acquisition failure does not commit; release failure cannot erase a durable commit", async () => {
    const context = await setup({
      beforeCoordinate: async () => {
        throw new Error("PRIVATE_GATE_FAILURE")
      },
    })
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    await expect(context.installer.commit(prepared.operationId, prepared.token)).rejects.toThrow("commit failed")
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    const releasing = createInstaller({
      registry: context.registry,
      beforeCoordinate: async () => async () => {
        throw new Error("PRIVATE_RELEASE_FAILURE")
      },
      coordinate: async () => ({ synced: true }),
    })
    const next = await releasing.prepare({ kind: "install", source: await context.archive() })
    const result = await releasing.commit(next.operationId, next.token)
    expect(result).toMatchObject({ committed: true, synced: false, cleanupPending: true })
    expect(result.warnings.join(" ")).toContain("fence release failed")
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RELEASE_FAILURE")
    expect((await Registry.snapshot(id, context.registry)).row).toBeDefined()
  })

  test("tampered content is rejected before acquiring the lifecycle fence", async () => {
    let acquired = 0
    const context = await setup({
      beforeCoordinate: async () => {
        acquired++
        return () => {}
      },
    })
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    await writeFile(path.join(context.root, "staging", prepared.operationId, "package", "web.js"), "tampered")
    await expect(context.installer.commit(prepared.operationId, prepared.token)).rejects.toThrow("content changed")
    expect(acquired).toBe(0)
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
  })

  test("explicit same-version updates and downgrades are marked in the bound preview", async () => {
    const context = await setup()
    await install(context, "2.0.0")
    const previous = (await Registry.snapshot(id, context.registry)).row!
    const location = previous.source.type === "archive" ? previous.source.location : ""
    for (const [version, versionChange] of [
      ["2.0.0", "same-version"],
      ["1.0.0", "downgrade"],
    ] as const) {
      const bytes = (await fixture(version, { "different.js": version })).bytes
      await writeFile(location, bytes)
      const prepared = await context.installer.prepare({
        kind: "update",
        id,
        source: { type: "local", path: location, sha256: sha(bytes) },
      })
      expect(prepared).toMatchObject({
        versionChange,
        sameVersion: versionChange === "same-version",
        downgrade: versionChange === "downgrade",
      })
      expect((await context.installer.commit(prepared.operationId, prepared.token)).committed).toBe(true)
      expect((await Registry.snapshot(id, context.registry)).row!.version).toBe(version)
    }
  })

  test("npm native root is rejected before granting a preview", async () => {
    const { bytes, pkg } = await fixture("1.0.0", { "binding.gyp": "{}" })
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    const metadata = {
      name: pkg.name,
      "dist-tags": { latest: pkg.version },
      versions: {
        [pkg.version]: {
          ...pkg,
          dist: { integrity, tarball: "https://registry.npmjs.org/test-extension/-/test-extension-1.0.0.tgz" },
        },
      },
    }
    const context = await setup({
      resolveNpm: (spec, options) => resolveNpm(spec, { ...options, transport: async () => metadata }),
      download: async () => bytes,
    })
    await expect(
      context.installer.prepare({ kind: "install", source: { type: "npm", spec: "test-extension@1.0.0" } }),
    ).rejects.toThrow("preparation failed")
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
  })

  test("default operation leases pin prepared staging and ownership metadata excludes capabilities", async () => {
    const context = await setup()
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    const owned = path.join(context.root, "staging", prepared.operationId, "ownership.json")
    const metadata = await readFile(owned, "utf8")
    expect(JSON.parse(metadata)).toMatchObject({
      owner: "opencode.extension-host",
      kind: "operation",
      operationId: prepared.operationId,
    })
    expect(metadata).not.toContain(prepared.token)
    expect(metadata).not.toContain("tokenHash")
    expect((await stat(owned)).mode & 0o777).toBe(0o600)
    let callback = false
    const live = await ExtensionLeases.withExclusiveOperation(context.registry, prepared.operationId, async () => {
      callback = true
    })
    expect(live.status).toBe("busy")
    expect(callback).toBe(false)
    await context.installer.close()
    expect((await context.installer.status(prepared.operationId, prepared.token)).state).toBe("cancelled")
    expect(await readdir(path.join(context.root, "staging"))).toEqual([])
    await expect(context.installer.prepare({ kind: "install", source: await context.archive() })).rejects.toThrow(
      "closed",
    )
  })

  test("generation lease precedes creation and stays held through CAS, coordination and cleanup", async () => {
    const held = new Set<string>()
    let registry = ""
    let root = ""
    let operationId = ""
    let installId = ""
    const leases: NonNullable<InstallerOptions["leases"]> = {
      acquireOperation: async (_registry, value) => {
        expect(await stat(path.join(root, "staging", value)).catch(() => undefined)).toBeUndefined()
        held.add(`operation:${value}`)
        const release = async () => {
          held.delete(`operation:${value}`)
        }
        return { proof: "flock", release, [Symbol.asyncDispose]: release }
      },
      acquire: async (_registry, value) => {
        expect(await stat(path.join(root, "packages", value)).catch(() => undefined)).toBeUndefined()
        expect(held.has(`operation:${operationId}`)).toBe(true)
        held.add(`generation:${value}`)
        const release = async () => {
          expect((await Registry.snapshot(id, registry)).row?.installId).toBe(value)
          expect(await readdir(path.join(root, "staging"))).toEqual([])
          held.delete(`generation:${value}`)
        }
        return { proof: "flock", release, [Symbol.asyncDispose]: release }
      },
    }
    const context = await setup({
      leases,
      coordinate: async () => {
        expect(held.has(`generation:${installId}`)).toBe(true)
        expect(held.has(`operation:${operationId}`)).toBe(true)
        return { synced: true, cleanupPending: false }
      },
    })
    registry = context.registry
    root = context.root
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    operationId = prepared.operationId
    installId = prepared.installId!
    const result = await context.installer.commit(operationId, prepared.token)
    expect(result).toMatchObject({ committed: true, synced: true, cleanupPending: false })
    expect(held.size).toBe(0)
    const receipt = await Registry.receipt(operationId, registry)
    expect(receipt?.cleanupPending).toBe(false)
    const ownership = path.join(root, "packages", installId, "installation.json")
    expect(JSON.parse(await readFile(ownership, "utf8"))).toMatchObject({
      owner: "opencode.extension-host",
      kind: "generation",
      operationId,
      installId,
      id,
    })
    expect((await stat(ownership)).mode & 0o777).toBe(0o600)
    const restart = createInstaller({ registry })
    expect((await restart.status(operationId, prepared.token)).cleanupPending).toBe(false)
  })

  test("lease-release failure keeps durable cleanupPending true", async () => {
    const release = async () => {}
    const context = await setup({
      leases: {
        acquireOperation: async () => ({ proof: "flock", release, [Symbol.asyncDispose]: release }),
        acquire: async () => {
          const fail = async () => {
            throw new Error("PRIVATE_LEASE_RELEASE")
          }
          return { proof: "flock", release: fail, [Symbol.asyncDispose]: fail }
        },
      },
      coordinate: async () => ({ synced: true, cleanupPending: false }),
    })
    const prepared = await context.installer.prepare({ kind: "install", source: await context.archive() })
    const result = await context.installer.commit(prepared.operationId, prepared.token)
    expect(result).toMatchObject({ committed: true, cleanupPending: true })
    expect((await Registry.receipt(prepared.operationId, context.registry))?.cleanupPending).toBe(true)
    expect(JSON.stringify(result)).not.toContain("PRIVATE_LEASE_RELEASE")
  })

  test("source URLs and dependency failures never leak signed URL errors", async () => {
    const context = await setup({
      download: async () => {
        throw new Error("SECRET_URL_CREDENTIAL")
      },
    })
    let error: unknown
    try {
      await context.installer.prepare({
        kind: "install",
        source: {
          type: "archive",
          url: "https://example.com/package.tgz?token=SECRET_URL_CREDENTIAL",
          sha256: "0".repeat(64),
        },
      })
    } catch (value) {
      error = value
    }
    expect(String(error)).not.toContain("SECRET_URL_CREDENTIAL")
  })
})
