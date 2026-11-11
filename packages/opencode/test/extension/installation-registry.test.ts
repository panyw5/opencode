import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { ExtensionRegistry } from "../../src/extension/registry"
import {
  ExtensionID,
  ArchiveSource,
  NpmSource,
  PathSource,
  RegistryRow,
  RegistryStore,
  Source,
  type OperationReceipt,
} from "../../src/extension/schema"
import {
  ExtensionInstallInput,
  ExtensionInstallPreview,
  ExtensionPrepareInput,
  ExtensionUpdateInput,
} from "../../src/extension/install-schema"
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

function releaseSource(
  overrides: Partial<Extract<Source, { type: "release" }>> = {},
): Extract<Source, { type: "release" }> {
  return {
    type: "release",
    descriptor: "https://example.com/stable.json",
    extensionID: id,
    version: "1.2.3",
    artifact: "https://cdn.example.com/extension-1.2.3.tgz",
    sha256: "c".repeat(64),
    descriptorSha256: "d".repeat(64),
    ...overrides,
  }
}

async function releaseCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  return { ...(await managed(f)), source: releaseSource() }
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

describe("release registry contracts", () => {
  test.each([1, 2])("v%i rejects release in active and retained rows without rewriting bytes", async (version) => {
    const f = await fixture()
    const candidate = { ...row(f.dir), source: releaseSource() }
    for (const contents of [
      { version, extensions: { [id]: candidate } },
      {
        version,
        extensions: {},
        retained: { [id]: { name: candidate.name, source: candidate.source, secretKeys: [], revision: 1 } },
      },
    ]) {
      const text = JSON.stringify(contents)
      await Bun.write(f.registry, text)
      expect(Schema.is(RegistryStore)(contents)).toBe(false)
      await expect(ExtensionRegistry.snapshot(id, f.registry)).rejects.toThrow()
      await expect(ExtensionRegistry.link(f.dir, undefined, f.registry)).rejects.toThrow()
      expect(await readFile(f.registry, "utf8")).toBe(text)
      expect(await Bun.file(`${f.registry}.v1.bak`).exists()).toBe(false)
      expect(Schema.is(RegistryStore)({ ...contents, version: 3 })).toBe(true)
    }
  })

  test("fixed legacy schema fixtures reject v3 and unknown sources before a simulated write", async () => {
    const f = await fixture()
    // These reproduce the checked legacy format gates, not a historical binary.
    const source = Schema.Union([PathSource, NpmSource, ArchiveSource])
    const legacyRow = Schema.Struct({ ...RegistryRow.fields, source })
    for (const version of [Schema.Literal(1), Schema.Literals([1, 2])]) {
      const legacy = Schema.Struct({ version, extensions: Schema.Record(ExtensionID, legacyRow) })
      for (const contents of [
        { version: 3, revision: 1, extensions: {} },
        { version: 1, extensions: { [id]: { ...row(f.dir), source: releaseSource() } } },
        { version: 2, extensions: { [id]: { ...row(f.dir), source: releaseSource() } } },
      ]) {
        const original = JSON.stringify(contents)
        await Bun.write(f.registry, original)
        const write = async () => {
          const parsed = Schema.decodeUnknownSync(legacy)(JSON.parse(await readFile(f.registry, "utf8")))
          await Bun.write(f.registry, JSON.stringify(parsed))
        }
        await expect(write()).rejects.toThrow()
        expect(await readFile(f.registry, "utf8")).toBe(original)
      }
    }
  })

  test("SDK source and preview expose the complete release snapshot and format approval", () => {
    const source = releaseSource()
    expect(Schema.decodeUnknownSync(Source)(source)).toEqual(source)
    const preview = {
      operationId: randomUUID(),
      expiresAt: Date.now(),
      kind: "install",
      id,
      name: "test-extension",
      version: "1.2.3",
      permissions: [],
      permissionsAdded: [],
      permissionsRemoved: [],
      contributes: {},
      source,
      expectedRegistryVersion: 2,
      registryUpgrade: { from: 2, to: 3 },
      hasServer: false,
      enable: false,
    }
    expect(Schema.decodeUnknownSync(ExtensionInstallPreview)(preview)).toEqual(preview)
    for (const schema of [ExtensionInstallInput, ExtensionUpdateInput]) {
      const payload = { operationId: randomUUID(), acceptRegistryUpgrade: true }
      expect(Schema.decodeUnknownSync(schema)(payload)).toEqual(payload)
      expect(Schema.is(schema)({ operationId: randomUUID() })).toBe(true)
    }
  })

  test("release requests and release-current updates reject mixed update selectors", () => {
    const source = { type: "release", url: "https://example.com/stable.json" }
    expect(Schema.is(ExtensionPrepareInput)({ kind: "install", source })).toBe(true)
    expect(Schema.is(ExtensionPrepareInput)({ kind: "update", id, target: "release-current" })).toBe(true)
    for (const selectors of [
      { source, version: "1.2.3" },
      { source, target: "release-current" },
      { version: "1.2.3", target: "release-current" },
      { source, version: "1.2.3", target: "release-current" },
    ]) {
      expect(() => Schema.decodeUnknownSync(ExtensionPrepareInput)({ kind: "update", id, ...selectors })).toThrow()
    }
  })

  test("release locations must already be canonical and public without query or fragment", () => {
    for (const location of [
      "http://example.com/stable.json",
      "https://user:password@example.com/stable.json",
      "https://EXAMPLE.com:443/stable.json",
      "https://example.com/stable.json?signature=private",
      "https://example.com/stable.json#private",
      "https://example.com/stable.json?",
      "https://example.com/stable.json#",
    ]) {
      expect(Schema.is(Source)(releaseSource({ descriptor: location }))).toBe(false)
      expect(Schema.is(Source)(releaseSource({ artifact: location }))).toBe(false)
    }
  })

  test("release identity excludes resolved snapshots and preserves every legacy identity byte", () => {
    const source = releaseSource()
    expect(ExtensionRegistry.sourceIdentity(source)).toBe(`release:${JSON.stringify([source.descriptor, id])}`)
    expect(
      ExtensionRegistry.sourceIdentity(
        releaseSource({
          version: "2.0.0",
          artifact: "https://other-cdn.example/new.tgz",
          sha256: "e".repeat(64),
          descriptorSha256: "f".repeat(64),
        }),
      ),
    ).toBe(ExtensionRegistry.sourceIdentity(source))
    expect(ExtensionRegistry.sourceIdentity(releaseSource({ descriptor: "https://example.com/other.json" }))).not.toBe(
      ExtensionRegistry.sourceIdentity(source),
    )
    expect(ExtensionRegistry.sourceIdentity(releaseSource({ extensionID: ExtensionID.make("test.other") }))).not.toBe(
      ExtensionRegistry.sourceIdentity(source),
    )
    expect(
      ExtensionRegistry.sourceIdentity({
        type: "npm",
        spec: "@scope/pkg@1.2.3",
        registry: "https://registry.example",
        integrity: "old",
      }),
    ).toBe("npm:https://registry.example:@scope/pkg")
    expect(
      ExtensionRegistry.sourceIdentity({ type: "archive", location: "https://example.com/a.tgz", sha256: "old" }),
    ).toBe("archive:https://example.com/a.tgz")
    expect(ExtensionRegistry.sourceIdentity({ type: "path", path: "/tmp/extensions/../example" })).toBe(
      "path:/tmp/example",
    )
  })

  test("ordinary v2 reads and legacy writes never upgrade the registry", async () => {
    const f = await fixture()
    expect(await ExtensionRegistry.snapshot(id, f.registry)).toEqual({
      registryVersion: 2,
      row: undefined,
      retained: undefined,
    })
    expect(await ExtensionRegistry.snapshotAll(f.registry)).toEqual({ registryVersion: 2, revision: 0, rows: {} })
    expect(await Bun.file(f.registry).exists()).toBe(false)
    const candidate = await managed(f)
    await ExtensionRegistry.commitInstallation(
      {
        id,
        row: candidate,
        expectedRevision: undefined,
        expectedRegistryVersion: 2,
        acceptRegistryUpgrade: true,
        receipt: receipt(candidate.installId!),
      },
      undefined,
      f.registry,
    )
    await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    const enabled = await ExtensionRegistry.setEnabled(id, true, undefined, f.registry)
    await ExtensionRegistry.commitRemoval(
      {
        id,
        expectedRevision: enabled.revision!,
        receipt: receipt(candidate.installId!, "uninstall"),
        purgeData: false,
      },
      f.registry,
    )
    expect((await ExtensionRegistry.snapshotAll(f.registry)).registryVersion).toBe(2)
    expect(JSON.parse(await readFile(f.registry, "utf8")).version).toBe(2)
  })

  test("release requires format CAS and explicit upgrade approval; rejected commits write nothing", async () => {
    const f = await fixture()
    const original = JSON.stringify({ version: 2, revision: 0, extensions: {} })
    await Bun.write(f.registry, original)
    const candidate = await releaseCandidate(f)
    const operation = receipt(candidate.installId!)
    const input = { id, row: candidate, expectedRevision: undefined, receipt: operation }
    for (const options of [
      { acceptRegistryUpgrade: true },
      { expectedRegistryVersion: 2 },
      { expectedRegistryVersion: 2, acceptRegistryUpgrade: false },
      { expectedRegistryVersion: 3, acceptRegistryUpgrade: true },
    ]) {
      await expect(
        ExtensionRegistry.commitInstallation({ ...input, ...options }, undefined, f.registry),
      ).rejects.toThrow()
      expect(await readFile(f.registry, "utf8")).toBe(original)
      expect(await ExtensionRegistry.receipt(operation.id, f.registry)).toBeUndefined()
    }
  })

  test("first release atomically stores v3, row and receipt and replays before version checks", async () => {
    const f = await fixture()
    const candidate = await releaseCandidate(f)
    const operation = receipt(candidate.installId!)
    const input = {
      id,
      row: candidate,
      expectedRevision: undefined,
      expectedRegistryVersion: 2,
      acceptRegistryUpgrade: true,
      receipt: operation,
    }
    const installed = await ExtensionRegistry.commitInstallation(input, undefined, f.registry)
    const committed = await readFile(f.registry, "utf8")
    const store = JSON.parse(committed)
    expect(store.version).toBe(3)
    expect(store.extensions[id].source).toEqual(candidate.source)
    expect(store.receipts[operation.id]).toEqual(operation)
    expect((await ExtensionRegistry.snapshot(id, f.registry)).registryVersion).toBe(3)
    expect((await ExtensionRegistry.snapshotAll(f.registry)).registryVersion).toBe(3)
    const replayed = await ExtensionRegistry.commitInstallation(
      { ...input, acceptRegistryUpgrade: false },
      undefined,
      f.registry,
    )
    expect(replayed.revision).toBe(installed.revision)
    expect(await readFile(f.registry, "utf8")).toBe(committed)
    expect(installed.enabled).toBe(false)
  })

  test("failed source checks do not perform an otherwise approved v3 upgrade", async () => {
    const f = await fixture()
    const archived = await managed(f)
    const installed = await ExtensionRegistry.commitInstallation(
      { id, row: archived, expectedRevision: undefined, receipt: receipt(archived.installId!) },
      undefined,
      f.registry,
    )
    await ExtensionRegistry.commitRemoval(
      {
        id,
        expectedRevision: installed.revision!,
        receipt: receipt(archived.installId!, "uninstall"),
        purgeData: false,
      },
      f.registry,
    )
    const state = await ExtensionRegistry.snapshot(id, f.registry)
    const original = await readFile(f.registry, "utf8")
    const candidate = await releaseCandidate(f)
    const operation = receipt(candidate.installId!)
    await expect(
      ExtensionRegistry.commitInstallation(
        {
          id,
          row: candidate,
          expectedRevision: undefined,
          expectedRetainedRevision: state.retained!.revision,
          expectedRegistryVersion: 2,
          acceptRegistryUpgrade: true,
          receipt: operation,
        },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("different installation")
    expect(await readFile(f.registry, "utf8")).toBe(original)
    expect(await ExtensionRegistry.receipt(operation.id, f.registry)).toBeUndefined()
  })

  test("format CAS protects legacy install and removal even if row revisions are unchanged", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const installed = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const store = JSON.parse(await readFile(f.registry, "utf8"))
    store.version = 3
    await Bun.write(f.registry, JSON.stringify(store))
    const original = await readFile(f.registry, "utf8")
    const next = await managed(f)
    await expect(
      ExtensionRegistry.commitInstallation(
        {
          id,
          row: next,
          expectedRevision: installed.revision,
          expectedRegistryVersion: 2,
          receipt: receipt(next.installId!, "update"),
        },
        undefined,
        f.registry,
      ),
    ).rejects.toThrow("registry version changed")
    await expect(
      ExtensionRegistry.commitRemoval(
        {
          id,
          expectedRevision: installed.revision!,
          expectedRegistryVersion: 2,
          receipt: receipt(candidate.installId!, "uninstall"),
          purgeData: false,
        },
        f.registry,
      ),
    ).rejects.toThrow("registry version changed")
    expect(await readFile(f.registry, "utf8")).toBe(original)
    // Old callers may omit format CAS; retaining that API never lowers v3.
    const updated = await ExtensionRegistry.commitInstallation(
      { id, row: next, expectedRevision: installed.revision, receipt: receipt(next.installId!, "update") },
      undefined,
      f.registry,
    )
    const removal = {
      id,
      expectedRevision: updated.revision!,
      expectedRegistryVersion: 3,
      receipt: receipt(next.installId!, "uninstall"),
      purgeData: false,
    }
    await ExtensionRegistry.commitRemoval(removal, f.registry)
    await ExtensionRegistry.commitRemoval({ ...removal, expectedRegistryVersion: 2 }, f.registry)
    expect((await ExtensionRegistry.snapshotAll(f.registry)).registryVersion).toBe(3)
  })

  test("v3 survives settings, enable, cleanup, final release removal, purge and legacy link", async () => {
    const f = await fixture()
    const candidate = await releaseCandidate(f)
    const operation = receipt(candidate.installId!)
    await ExtensionRegistry.commitInstallation(
      {
        id,
        row: candidate,
        expectedRevision: undefined,
        expectedRegistryVersion: 2,
        acceptRegistryUpgrade: true,
        receipt: operation,
      },
      undefined,
      f.registry,
    )
    await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    const enabled = await ExtensionRegistry.setEnabled(id, true, undefined, f.registry)
    await ExtensionRegistry.finishCleanupReceipt(operation.id, f.registry)
    const removal = receipt(candidate.installId!, "uninstall")
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: enabled.revision!, expectedRegistryVersion: 3, receipt: removal, purgeData: false },
      f.registry,
    )
    const state = await ExtensionRegistry.snapshot(id, f.registry)
    expect(state.registryVersion).toBe(3)
    expect(state.row).toBeUndefined()
    await ExtensionRegistry.withPurge(id, state.retained!.revision, async () => undefined, f.registry)
    await ExtensionRegistry.finishCleanupReceipt(removal.id, f.registry)
    await ExtensionRegistry.link(f.dir, undefined, f.registry)
    expect((await ExtensionRegistry.snapshotAll(f.registry)).registryVersion).toBe(3)
    expect(JSON.parse(await readFile(f.registry, "utf8")).version).toBe(3)
  })

  test("same-descriptor release updates and retained restoration preserve secrets, other sources cannot inherit", async () => {
    const f = await fixture()
    const candidate = await releaseCandidate(f)
    await ExtensionRegistry.commitInstallation(
      {
        id,
        row: candidate,
        expectedRevision: undefined,
        expectedRegistryVersion: 2,
        acceptRegistryUpgrade: true,
        receipt: receipt(candidate.installId!),
      },
      undefined,
      f.registry,
    )
    const configured = await ExtensionRegistry.updateSettings(id, { token: "private" }, undefined, f.registry)
    const next = await releaseCandidate(f)
    next.source = releaseSource({
      artifact: "https://different-cdn.example/new.tgz",
      sha256: "e".repeat(64),
      descriptorSha256: "f".repeat(64),
    })
    const updated = await ExtensionRegistry.commitInstallation(
      {
        id,
        row: next,
        expectedRevision: configured.revision,
        expectedRegistryVersion: 3,
        receipt: receipt(next.installId!, "update"),
      },
      undefined,
      f.registry,
    )
    expect(updated.settings?.token).toBe(ExtensionRegistry.SECRET_MASK)
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: updated.revision!, receipt: receipt(next.installId!, "uninstall"), purgeData: false },
      f.registry,
    )
    const retained = (await ExtensionRegistry.snapshot(id, f.registry)).retained!
    const original = await readFile(f.registry, "utf8")
    for (const source of [
      releaseSource({ descriptor: "https://other.example/stable.json" }),
      { type: "archive" as const, location: candidate.source.artifact, sha256: candidate.source.sha256 },
      { type: "npm" as const, spec: "test-extension@1.2.3", registry: "https://registry.example", integrity: "old" },
    ]) {
      const other = { ...(await managed(f)), source }
      await expect(
        ExtensionRegistry.commitInstallation(
          {
            id,
            row: other,
            expectedRevision: undefined,
            expectedRetainedRevision: retained.revision,
            expectedRegistryVersion: 3,
            receipt: receipt(other.installId!),
          },
          undefined,
          f.registry,
        ),
      ).rejects.toThrow("different installation")
      expect(await readFile(f.registry, "utf8")).toBe(original)
    }
    await expect(ExtensionRegistry.link(f.dir, undefined, f.registry)).rejects.toThrow("different installation")
    const restored = await releaseCandidate(f)
    await ExtensionRegistry.commitInstallation(
      {
        id,
        row: restored,
        expectedRevision: undefined,
        expectedRetainedRevision: retained.revision,
        expectedRegistryVersion: 3,
        receipt: receipt(restored.installId!),
      },
      undefined,
      f.registry,
    )
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row?.settings?.token).toBe("private")
  })
})

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

  test("confirmed archive updates preserve stable data ownership but new installs cannot choose it", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const first = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const changed = await managed(f)
    changed.source = { type: "archive", location: "https://other.example/new-version.tgz", sha256: "a".repeat(64) }
    changed.dataSource = { type: "archive", location: "/forged", sha256: "forged" }
    const updated = await ExtensionRegistry.commitInstallation(
      { id, row: changed, expectedRevision: first.revision, receipt: receipt(changed.installId!, "update") },
      undefined,
      f.registry,
    )
    expect(updated.source).toEqual(changed.source)
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row?.dataSource).toEqual(candidate.source)
    await ExtensionRegistry.commitRemoval(
      { id, expectedRevision: updated.revision!, receipt: receipt(changed.installId!, "uninstall"), purgeData: false },
      f.registry,
    )
    const retained = (await ExtensionRegistry.snapshot(id, f.registry)).retained!
    expect(retained.dataSource).toEqual(candidate.source)
    const reinstall = await managed(f)
    reinstall.source = { ...changed.source, location: "/another/staged/path.tgz" }
    await ExtensionRegistry.commitInstallation(
      {
        id,
        row: reinstall,
        expectedRevision: undefined,
        expectedRetainedRevision: retained.revision,
        receipt: receipt(reinstall.installId!),
      },
      undefined,
      f.registry,
    )
    expect((await ExtensionRegistry.snapshot(id, f.registry)).row?.dataSource).toEqual(candidate.source)
  })

  test("rejects a different source family and an absent-row ABA replacement", async () => {
    const f = await fixture()
    const candidate = await managed(f)
    const first = await ExtensionRegistry.commitInstallation(
      { id, row: candidate, expectedRevision: undefined, receipt: receipt(candidate.installId!) },
      undefined,
      f.registry,
    )
    const changed = await managed(f)
    changed.source = {
      type: "npm",
      spec: "test-extension@2.0.0",
      registry: "https://other.example",
      integrity: "sha512-other",
    }
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
