import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import tar from "tar-stream"
import { downloadArchive, requestJsonDocument, type DownloadTransport } from "../../src/extension/download"
import { createInstaller, type InstallerOptions } from "../../src/extension/install"
import { resolveRelease } from "../../src/extension/release"
import * as Registry from "../../src/extension/registry"
import { ExtensionID } from "../../src/extension/schema"

const id = ExtensionID.make("integration.release-viewer")
const descriptorURL = "https://releases.example.test/viewer/stable.json"
const publicAddress = "93.184.216.34"
const secretQuery = "INTEGRATION_PRIVATE_DOWNLOAD_TOKEN"
const executionKey = "__opencodeReleaseIntegrationExecuted"
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const roots: string[] = []
const installers: ReturnType<typeof createInstaller>[] = []

afterEach(async () => {
  await Promise.all(installers.splice(0).map((installer) => installer.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  Reflect.deleteProperty(globalThis, executionKey)
})

async function release(version: string) {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const completed = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.from(chunk))
  })()
  const pkg = {
    name: "release-integration-viewer",
    version,
    exports: { "./web": "./web.js", "./server": "./server.js" },
    opencode: {
      manifestVersion: 1,
      id,
      displayName: "Release integration viewer",
      web: { apiVersion: 1 },
      contributes: { settings: { apiKey: { type: "string", title: "Key", secret: true } } },
    },
  }
  const entry = `globalThis.${executionKey} = true; throw new Error('Installation must not execute extension code')`
  for (const [name, content] of Object.entries({
    "package.json": JSON.stringify(pkg),
    "web.js": entry,
    "server.js": entry,
    "version.txt": version,
  }))
    pack.entry({ name: `package/${name}`, mode: 0o644 }, content)
  pack.finalize()
  await completed
  const bytes = gzipSync(Buffer.concat(chunks))
  const artifact = `https://artifacts.example.test/viewer-${version}.tgz?signature=${secretQuery}`
  const descriptor = Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        id,
        version,
        artifact: { url: artifact, sha256: hash(bytes).toUpperCase() },
      },
      null,
      2,
    ) + "\n",
  )
  return { version, bytes, artifact, descriptor }
}

async function setup() {
  const first = await release("1.0.0")
  const second = await release("2.0.0")
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "oc-release-integration-")))
  roots.push(root)
  const registry = path.join(root, "registry.json")
  await writeFile(registry, JSON.stringify({ version: 2, revision: 0, extensions: {}, receipts: {}, retained: {} }))
  let current = first
  const artifacts = new Map([
    [first.artifact, first.bytes],
    [second.artifact, second.bytes],
  ])
  const requests: string[] = []
  const lookups: string[] = []
  let cancellations = 0

  // Trusted fixture dependency injection only: the real downloader still validates all DNS
  // answers, pins the public address, limits bytes and verifies raw archive digests.
  // Neither request payloads nor production configuration can select this transport.
  const transport: DownloadTransport = {
    async lookup(hostname, signal) {
      expect(signal.aborted).toBe(false)
      expect(["releases.example.test", "artifacts.example.test"]).toContain(hostname)
      lookups.push(hostname)
      return [{ address: publicAddress, family: 4 }]
    },
    async request(input) {
      expect(input.address).toBe(publicAddress)
      expect(input.family).toBe(4)
      expect(input.signal.aborted).toBe(false)
      expect(input.url.protocol).toBe("https:")
      requests.push(input.url.href)
      const bytes = input.url.href === descriptorURL ? current.descriptor : artifacts.get(input.url.href)
      if (!bytes) throw new Error("Unexpected integration fixture request")
      return {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
        body: (async function* () {
          yield bytes.subarray(0, 11)
          yield bytes.subarray(11)
        })(),
        cancel() {
          cancellations++
        },
      }
    },
  }
  const options: InstallerOptions = {
    registry,
    resolveRelease: (url, options) =>
      resolveRelease(url, {
        ...options,
        transport: (url, options) => requestJsonDocument(url, { ...options, transport }),
      }),
    download: (input) => {
      if (!("sha256" in input)) throw new Error("Unexpected npm download in release integration")
      return downloadArchive({ ...input, transport })
    },
  }
  function start() {
    const installer = createInstaller(options)
    installers.push(installer)
    return installer
  }
  return {
    root,
    registry,
    first,
    second,
    requests,
    lookups,
    artifacts,
    start,
    publishSecond() {
      current = second
    },
    cancellations: () => cancellations,
  }
}

describe("release installation real resolver integration", () => {
  test("previews and freezes A, confirms v2 to v3, updates from current B and retains authenticated receipts/data", async () => {
    const context = await setup()
    const installer = context.start()
    const before = await readFile(context.registry, "utf8")
    const prepared = await installer.prepare({
      kind: "install",
      source: { type: "release", url: "HTTPS://Releases.Example.Test:443/viewer/stable.json" },
    })
    expect(prepared).toMatchObject({
      id,
      version: "1.0.0",
      enable: false,
      hasServer: true,
      expectedRegistryVersion: 2,
      registryUpgrade: { from: 2, to: 3 },
      source: {
        type: "release",
        descriptor: descriptorURL,
        extensionID: id,
        version: "1.0.0",
        artifact: "https://artifacts.example.test/viewer-1.0.0.tgz",
        sha256: hash(context.first.bytes),
        descriptorSha256: hash(context.first.descriptor),
      },
    })
    expect(Reflect.get(globalThis, executionKey)).toBeUndefined()
    expect(await readFile(context.registry, "utf8")).toBe(before)
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect(context.requests).toEqual([descriptorURL, context.first.artifact])
    expect(context.lookups).toEqual(["releases.example.test", "artifacts.example.test"])
    expect(context.cancellations()).toBe(2)
    expect(JSON.stringify(prepared)).not.toContain(secretQuery)
    expect(JSON.stringify(prepared)).not.toContain("signature=")
    const metadata = await readFile(path.join(context.root, "staging", prepared.operationId, "operation.json"), "utf8")
    expect(metadata).not.toContain(secretQuery)
    expect(metadata).not.toContain(prepared.token)

    await expect(installer.commit(prepared.operationId, prepared.token)).rejects.toThrow("explicit confirmation")
    expect(await readFile(context.registry, "utf8")).toBe(before)
    expect((await Registry.snapshot(id, context.registry)).registryVersion).toBe(2)

    // Both the stable descriptor and the old artifact URL now serve B. Commit must
    // use the verified staged A, with no new descriptor or artifact request.
    context.publishSecond()
    context.artifacts.set(context.first.artifact, context.second.bytes)
    const committed = await installer.commit(prepared.operationId, prepared.token, { acceptRegistryUpgrade: true })
    expect(committed).toMatchObject({ committed: true, synced: false, cleanupPending: true })
    expect(context.requests).toEqual([descriptorURL, context.first.artifact])
    const installedA = await Registry.snapshot(id, context.registry)
    expect(installedA.registryVersion).toBe(3)
    expect(installedA.row).toMatchObject({ version: "1.0.0", enabled: false, installId: prepared.installId })
    expect(await readFile(path.join(installedA.row!.dir, "version.txt"), "utf8")).toBe("1.0.0")
    expect(Reflect.get(globalThis, executionKey)).toBeUndefined()
    const storeA = JSON.parse(await readFile(context.registry, "utf8"))
    expect(JSON.stringify(storeA)).not.toContain(secretQuery)
    expect(storeA.receipts[prepared.operationId].tokenHash).not.toBe(prepared.token)
    expect(storeA.receipts[prepared.operationId].installId).toBe(prepared.installId)
    expect(await installer.commit(prepared.operationId, prepared.token)).toEqual(committed)

    await Registry.updateSettings(id, { apiKey: "RETAINED_SECRET_SETTING" }, undefined, context.registry)
    const update = await installer.prepare({ kind: "update", id, target: "release-current" })
    expect(update).toMatchObject({ oldVersion: "1.0.0", version: "2.0.0", versionChange: "upgrade" })
    expect(update.registryUpgrade).toBeUndefined()
    expect(update.source).toMatchObject({
      descriptor: descriptorURL,
      descriptorSha256: hash(context.second.descriptor),
    })
    expect(context.requests).toEqual([descriptorURL, context.first.artifact, descriptorURL, context.second.artifact])
    expect(JSON.stringify(update)).not.toContain(secretQuery)
    expect(JSON.stringify(update)).not.toContain("RETAINED_SECRET_SETTING")
    expect((await installer.commit(update.operationId, update.token)).committed).toBe(true)
    const installedB = (await Registry.snapshot(id, context.registry)).row!
    expect(installedB).toMatchObject({
      version: "2.0.0",
      enabled: false,
      installedAt: installedA.row!.installedAt,
      settings: { apiKey: "RETAINED_SECRET_SETTING" },
      source: {
        type: "release",
        descriptor: descriptorURL,
        extensionID: id,
        sha256: hash(context.second.bytes),
        descriptorSha256: hash(context.second.descriptor),
      },
    })
    expect(installedB.installId).not.toBe(installedA.row!.installId)
    expect(await readFile(path.join(installedB.dir, "version.txt"), "utf8")).toBe("2.0.0")

    const uninstall = await installer.prepare({ kind: "uninstall", id })
    expect(JSON.stringify(uninstall)).not.toContain("RETAINED_SECRET_SETTING")
    expect((await installer.commit(uninstall.operationId, uninstall.token)).committed).toBe(true)
    const removed = await Registry.snapshot(id, context.registry)
    expect(removed.registryVersion).toBe(3)
    expect(removed.row).toBeUndefined()
    expect(removed.retained).toMatchObject({
      settings: { apiKey: "RETAINED_SECRET_SETTING" },
      source: { type: "release", descriptor: descriptorURL, extensionID: id, version: "2.0.0" },
    })
    expect(await stat(installedB.dir)).toBeDefined()
    expect((await Registry.receipt(uninstall.operationId, context.registry))?.kind).toBe("uninstall")

    await installer.close()
    const restarted = context.start()
    const networkCount = context.requests.length
    for (const operation of [prepared, update, uninstall]) {
      expect(await restarted.status(operation.operationId, operation.token)).toMatchObject({
        operationId: operation.operationId,
        committed: true,
        synced: false,
      })
      await expect(restarted.status(operation.operationId, "wrong-capability")).rejects.toThrow("capability")
    }
    expect(context.requests).toHaveLength(networkCount)
    expect(JSON.stringify(await restarted.status(uninstall.operationId, uninstall.token))).not.toContain(secretQuery)

    // A new candidate from the same stable source may inherit retained settings;
    // changing artifact bytes/URL/version did not change source ownership.
    const reinstall = await restarted.prepare({ kind: "install", source: { type: "release", url: descriptorURL } })
    expect(reinstall.registryUpgrade).toBeUndefined()
    expect((await restarted.commit(reinstall.operationId, reinstall.token)).committed).toBe(true)
    const restored = await Registry.snapshot(id, context.registry)
    expect(restored.retained).toBeUndefined()
    expect(restored.row).toMatchObject({
      version: "2.0.0",
      settings: { apiKey: "RETAINED_SECRET_SETTING" },
      enabled: false,
    })
    expect(Reflect.get(globalThis, executionKey)).toBeUndefined()
    expect(context.cancellations()).toBe(context.requests.length)
  })

  test("real raw-byte verification rejects a substituted artifact before preview or registry upgrade", async () => {
    const context = await setup()
    const installer = context.start()
    const before = await readFile(context.registry, "utf8")
    context.artifacts.set(context.first.artifact, context.second.bytes)
    await expect(
      installer.prepare({ kind: "install", source: { type: "release", url: descriptorURL } }),
    ).rejects.toThrow()
    expect(context.requests).toEqual([descriptorURL, context.first.artifact])
    expect(await readFile(context.registry, "utf8")).toBe(before)
    const snapshot = await Registry.snapshot(id, context.registry)
    expect(snapshot.registryVersion).toBe(2)
    expect(snapshot.row).toBeUndefined()
    expect(snapshot.retained).toBeUndefined()
    expect(Reflect.get(globalThis, executionKey)).toBeUndefined()
  })
})
