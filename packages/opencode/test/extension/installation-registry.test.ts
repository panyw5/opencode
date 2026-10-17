import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionID, type OperationReceipt, type RegistryRow } from "../../src/extension/schema"
import { extensionPackage } from "./fixture"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc-ext-install-registry-")))
  roots.push(root)
  const registry = path.join(root, "registry.json")
  const dir = await extensionPackage(root, { settings: { token: { type: "string", title: "Token", secret: true } } })
  return { root, registry, dir }
}

const id = ExtensionID.make("test.extension")
function row(dir: string): RegistryRow {
  return {
    name: "test-extension",
    version: "1.2.3",
    source: { type: "archive", location: "https://example.com/example.tgz", sha256: "a".repeat(64) },
    dir,
    enabled: false,
    installedAt: Date.now(),
    installId: randomUUID(),
  }
}
async function managed(f: Awaited<ReturnType<typeof fixture>>, source = f.dir) {
  const candidate = row(source)
  const dir = path.join(f.root, "packages", candidate.installId!, "package")
  await cp(source, dir, { recursive: true })
  return { ...candidate, dir }
}

function receipt(installId: string, kind: OperationReceipt["kind"] = "install"): OperationReceipt {
  return {
    id: randomUUID(),
    kind,
    extensionID: id,
    tokenHash: "b".repeat(64),
    committedAt: Date.now(),
    installId,
    cleanupPending: true,
  }
}

describe("managed extension registry", () => {
  test("migrates v1 under the lock without losing settings and preserves the backup", async () => {
    const f = await fixture()
    const original = JSON.stringify({
      version: 1,
      extensions: { [id]: { ...row(f.dir), source: { type: "path", path: f.dir }, settings: { token: "private" } } },
    })
    await Bun.write(f.registry, original)
    const info = await ExtensionRegistry.get(id, undefined, f.registry)
    expect(info.settings?.token).toBe(ExtensionRegistry.SECRET_MASK)
    expect(await readFile(`${f.registry}.v1.bak`, "utf8")).toBe(original)
    expect(JSON.parse(await readFile(f.registry, "utf8")).version).toBe(2)
    await ExtensionRegistry.list(undefined, f.registry)
    expect(await readFile(`${f.registry}.v1.bak`, "utf8")).toBe(original)
  })

  test("rejects unknown versions without overwriting them", async () => {
    const f = await fixture()
    const original = JSON.stringify({ version: 99, extensions: {} })
    await Bun.write(f.registry, original)
    await expect(ExtensionRegistry.list(undefined, f.registry)).rejects.toThrow()
    expect(await readFile(f.registry, "utf8")).toBe(original)
  })

  test("commits the pointer and receipt together, defaults disabled, and replays idempotently", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const operation = receipt(candidate.installId!)
    const input = { id, row: candidate, expectedRevision: undefined, receipt: operation }
    const a = await ExtensionRegistry.commitInstallation(input, undefined, f.registry)
    const b = await ExtensionRegistry.commitInstallation(input, undefined, f.registry)
    expect(a.enabled).toBe(false)
    expect(b.revision).toBe(a.revision)
    expect(b.web?.base).toBe(a.web?.base)
    const store = JSON.parse(await readFile(f.registry, "utf8"))
    expect(store.extensions[id].installId).toBe(operation.installId)
    expect(store.receipts[operation.id]).toEqual(operation)
    expect((await ExtensionRegistry.linked(id, f.registry))?.manifest.versionSegment).toContain(candidate.installId!)
  })

  test("all settings and enable writes advance revision and reject stale replacement", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const first = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const settings = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    expect(settings.revision!).toBeGreaterThan(first.revision!)
    const enabled = await ExtensionRegistry.setEnabled(id, true, undefined, f.registry)
    expect(enabled.revision!).toBeGreaterThan(settings.revision!)
    const next = await managed(f)
    await expect(
      ExtensionRegistry.commitInstallation(
        { id, row: next, expectedRevision: first.revision, receipt: receipt(next.installId!, "update") },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("changed")
    expect((await ExtensionRegistry.get(id, undefined, f.registry)).settings?.token).toBe(ExtensionRegistry.SECRET_MASK)
  })

  test("retains settings on uninstall and restores only matching source identity", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const settings = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    const removed = receipt(candidate.installId!, "uninstall")
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: settings.revision!, receipt: removed, purgeData: false },
      f.registry,
    )
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: settings.revision!, receipt: removed, purgeData: false },
      f.registry,
    )
    expect(await ExtensionRegistry.list(undefined, f.registry)).toEqual([])
    const next = await managed(f)
    const retained = await ExtensionRegistry.snapshot(id, f.registry)
    await ExtensionRegistry.commitInstallation(
      {
        id,
        row: next,
        expectedRevision: undefined,
        expectedRetainedRevision: retained.retained?.revision,
        receipt: receipt(next.installId!),
      },
      undefined,
      f.registry,
    )
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row?.settings?.token).toBe("private")
  })

  test("same-source development relink restores retained settings and secret classifications", async () => {
    const f = await fixture()
    await ExtensionRegistry.link(f.dir, undefined, f.registry)
    const configured = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: configured.revision!, receipt: receipt(randomUUID(), "uninstall"), purgeData: false },
      f.registry,
    )
    const linked = await ExtensionRegistry.link(f.dir, undefined, f.registry)
    const restored = await ExtensionRegistry.snapshot(id, f.registry)
    expect(linked.settings?.token).toBe(ExtensionRegistry.SECRET_MASK)
    expect(restored.row?.settings?.token).toBe("private")
    expect(restored.row?.secretKeys).toContain("token")
    expect(restored.retained).toBeUndefined()
  })

  test("development relink cannot silently downgrade a retained secret", async () => {
    const f = await fixture()
    await ExtensionRegistry.link(f.dir, undefined, f.registry)
    const configured = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: configured.revision!, receipt: receipt(randomUUID(), "uninstall"), purgeData: false },
      f.registry,
    )
    const before = (await ExtensionRegistry.snapshot(id, f.registry)).retained
    const file = path.join(f.dir, "package.json")
    const pkg = JSON.parse(await readFile(file, "utf8"))
    pkg.opencode.contributes.settings.token.secret = false
    await Bun.write(file, JSON.stringify(pkg))
    await expect(ExtensionRegistry.link(f.dir, undefined, f.registry)).rejects.toThrow("migration")
    const after = await ExtensionRegistry.snapshot(id, f.registry)
    expect(after.row).toBeUndefined()
    expect(after.retained).toEqual(before)
  })

  test("retained files prevent another source or development link from taking over an id", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const installed = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    await ExtensionRegistry.commitRemoval(
      {
        id,
        expectedRevision: installed.revision!,
        receipt: receipt(candidate.installId!, "uninstall"),
        purgeData: false,
      },
      f.registry,
    )
    const retained = (await ExtensionRegistry.snapshot(id, f.registry)).retained!
    const different = await managed(f)
    different.source = { type: "archive", location: "https://other.example/replacement.tgz", sha256: "c".repeat(64) }
    await expect(
      ExtensionRegistry.commitInstallation(
        {
          id,
          row: different,
          expectedRevision: undefined,
          expectedRetainedRevision: retained.revision,
          receipt: receipt(different.installId!),
        },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("data belongs to a different installation")
    await expect(ExtensionRegistry.link(f.dir, undefined, f.registry)).rejects.toThrow(
      "data belongs to a different installation",
    )
    expect((await ExtensionRegistry.snapshot(id, f.registry)).retained).toEqual(retained)
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row).toBeUndefined()
  })

  test("repairs a broken managed package while preserving stored secret classifications", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const settings = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    await rm(path.join(candidate.dir, "package.json"))
    const next = await managed(f)
    await ExtensionRegistry.commitInstallation(
      { id, row: next, expectedRevision: settings.revision, receipt: receipt(next.installId!, "update") },
      undefined,
      f.registry,
    )
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row?.settings?.token).toBe("private")
    expect((await ExtensionRegistry.get(id, undefined, f.registry)).settings?.token).toBe(ExtensionRegistry.SECRET_MASK)
  })

  test("managed metadata cannot change without a registry commit", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const file = path.join(candidate.dir, "package.json")
    const pkg = JSON.parse(await readFile(file, "utf8"))
    await Bun.write(file, JSON.stringify({ ...pkg, name: "replacement-package" }))
    expect((await ExtensionRegistry.get(id, undefined, f.registry)).state).toBe("error")
    await expect(ExtensionRegistry.linked(id, f.registry)).rejects.toThrow("identity")
  })

  test("historical secret masks never overwrite the stored value after a development relink", async () => {
    const f = await fixture()
    await ExtensionRegistry.link(f.dir, undefined, f.registry)
    await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    const file = path.join(f.dir, "package.json")
    const pkg = JSON.parse(await readFile(file, "utf8"))
    pkg.opencode.contributes.settings.token.secret = false
    await Bun.write(file, JSON.stringify(pkg))
    await ExtensionRegistry.link(f.dir, undefined, f.registry)
    await ExtensionRegistry.updateSettings(id, { token: ExtensionRegistry.SECRET_MASK }, undefined, f.registry)
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row?.settings?.token).toBe("private")
  })

  test("rejects a different source and an absent-row ABA replacement", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const first = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const changed = await managed(f)
    changed.source = { type: "archive", location: "https://other.example/extension.tgz", sha256: "a".repeat(64) }
    await expect(
      ExtensionRegistry.commitInstallation(
        { id, row: changed, expectedRevision: first.revision, receipt: receipt(changed.installId!, "update") },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("different installation")
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: first.revision!, receipt: receipt(candidate.installId!, "uninstall"), purgeData: false },
      f.registry,
    )
    const next = await managed(f)
    await expect(
      ExtensionRegistry.commitInstallation(
        { id, row: next, expectedRevision: undefined, receipt: receipt(next.installId!) },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("data changed")
  })

  test("rejects a registry candidate outside its owned generation", async () => {
    const f = await fixture()
    const candidate = row(f.dir)
    await expect(
      ExtensionRegistry.commitInstallation(
        { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("outside managed storage")
  })

  test("purge writes intent before touching files and permits replacement only after completion", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const installed = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const configured = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    const removal = { ...receipt(candidate.installId!, "uninstall"), purgeData: true }
    await ExtensionRegistry.commitRemoval(
      {
        id,
        expectedRevision: configured.revision!,
        receipt: removal,
        purgeData: false,
      },
      f.registry,
    )
    const retained = (await ExtensionRegistry.snapshot(id, f.registry)).retained!
    await expect(
      ExtensionRegistry.withPurge(
        id,
        retained.revision,
        async () => {
          throw new Error("rename failed")
        },
        f.registry,
      ),
    ).rejects.toThrow("rename failed")
    const intent = (await ExtensionRegistry.snapshot(id, f.registry)).retained!
    expect(intent.purging).toBe(true)
    expect(intent.settings?.token).toBe("private")
    const next = await managed(f)
    await expect(
      ExtensionRegistry.commitInstallation(
        {
          id,
          row: next,
          expectedRevision: undefined,
          expectedRetainedRevision: retained.revision,
          receipt: receipt(next.installId!),
        },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("cleanup")
    let visibleKeys: string[] = []
    const completed = await ExtensionRegistry.withPurge(
      id,
      retained.revision,
      async (identity) => {
        visibleKeys = Object.keys(identity)
        return "renamed"
      },
      f.registry,
    )
    expect(completed).toMatchObject({ purged: true, value: "renamed" })
    expect(visibleKeys).not.toContain("settings")
    const clean = (await ExtensionRegistry.snapshot(id, f.registry)).retained!
    expect(clean.settings).toBeUndefined()
    expect(clean.purging).toBe(false)
    expect(clean.purgedAt).toBeNumber()
    expect((await ExtensionRegistry.receipt(removal.id, f.registry))?.purgeCompleted).toBe(true)
    next.source = { type: "archive", location: "https://other.example/new.tgz", sha256: "c".repeat(64) }
    expect(
      (
        await ExtensionRegistry.commitInstallation(
          {
            id,
            row: next,
            expectedRevision: undefined,
            expectedRetainedRevision: clean.revision,
            receipt: receipt(next.installId!),
          },
          undefined,
          f.registry,
        )
      ).enabled,
    ).toBe(false)
    expect(installed.enabled).toBe(false)
  })

  test("generation collection is gated by current registry references", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const installed = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    let called = false
    expect(
      await ExtensionRegistry.withUnreferencedGeneration(
        candidate.installId!,
        async () => {
          called = true
        },
        f.registry,
      ),
    ).toEqual({ collected: false })
    expect(called).toBe(false)
    await ExtensionRegistry.commitRemoval(
      {
        id,
        expectedRevision: installed.revision!,
        receipt: receipt(candidate.installId!, "uninstall"),
        purgeData: false,
      },
      f.registry,
    )
    expect(
      await ExtensionRegistry.withUnreferencedGeneration(candidate.installId!, async () => "safe-rename", f.registry),
    ).toEqual({ collected: true, value: "safe-rename" })
  })

  test("a development link into a managed generation prevents collection", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    await ExtensionRegistry.link(candidate.dir, undefined, f.registry)
    const result = await ExtensionRegistry.withUnreferencedGeneration(
      candidate.installId!,
      async () => {
        throw new Error("A referenced generation must not be renamed")
      },
      f.registry,
    )
    expect(result).toEqual({ collected: false })
    expect(await Bun.file(path.join(candidate.dir, "package.json")).exists()).toBe(true)
  })

  test("rejects secret downgrade before writing the replacement", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const info = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    const nextRoot = path.join(f.root, "next")
    const nextDir = await extensionPackage(nextRoot, { settings: { token: { type: "string", title: "Token" } } })
    const next = await managed(f, nextDir)
    await expect(
      ExtensionRegistry.commitInstallation(
        { id, row: next, expectedRevision: info.revision, receipt: receipt(next.installId!, "update") },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("migration")
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row?.installId).toBe(candidate.installId)
  })
})
