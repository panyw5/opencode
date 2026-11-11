import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { gzipSync } from "node:zlib"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import tar from "tar-stream"
import { ConfigProvider, Context, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { createInstaller, InstallError, type InstallerOptions } from "../../src/extension/install"
import * as Registry from "../../src/extension/registry"
import { ExtensionID } from "../../src/extension/schema"
import {
  installExtensionInstallAdapter,
  resetExtensionInstallAdapter,
} from "../../src/server/routes/instance/httpapi/handlers/extension-install"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import type { InstallationService } from "../../src/extension/install-service"

/**
 * Private staged-release channel (desktop only):
 * installer.prepareRelease(request, { url, descriptor, path }) installs or
 * updates from a renderer-staged descriptor text plus archive file without any
 * network access. The public HTTP surface must never accept that envelope.
 */

const id = ExtensionID.make("test.private-release")
const releaseURL = "https://example.com/stable.json"
const artifactURL = "https://cdn.example.com/extension.tgz?signature=PRIVATE"

const roots: string[] = []
const installers: ReturnType<typeof createInstaller>[] = []
afterEach(async () => {
  resetExtensionInstallAdapter()
  await Promise.all(installers.splice(0).map((installer) => installer.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const sha = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex")

async function fixture(version = "1.0.0") {
  const pkg = {
    name: "private-release-extension",
    version,
    exports: { "./web": "./web.js", "./server": "./server.js" },
    opencode: {
      manifestVersion: 1,
      id,
      displayName: "Private Release Fixture",
      web: { apiVersion: 1 },
      permissions: [],
      contributes: {},
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
  })) {
    pack.entry({ name: `package/${name}`, mode: 0o777 }, content)
  }
  pack.finalize()
  await completed
  return { bytes: gzipSync(Buffer.concat(chunks)), pkg }
}

function descriptor(bytes: Uint8Array, version = "1.0.0", extensionID: string = id, url = artifactURL) {
  return JSON.stringify({ schemaVersion: 1, id: extensionID, version, artifact: { url, sha256: sha(bytes) } })
}

async function setup(options: InstallerOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-private-release-")))
  roots.push(root)
  const registry = path.join(root, "registry.json")
  const installer = createInstaller({ registry, ...options })
  installers.push(installer)
  async function staged(version = "1.0.0", extensionID: string = id, artifactSha256?: string) {
    const { bytes } = await fixture(version)
    const file = path.join(root, `staged-${version}-${extensionID}.tgz`)
    await writeFile(file, bytes)
    const text = JSON.stringify({
      schemaVersion: 1,
      id: extensionID,
      version,
      artifact: { url: artifactURL, sha256: artifactSha256 ?? sha(bytes) },
    })
    return { bytes, file, descriptor: text }
  }
  const installRequest = { kind: "install" as const, source: { type: "release" as const, url: releaseURL } }
  const envelope = (staged: { descriptor: string; file: string }, url = releaseURL) => ({
    url,
    descriptor: staged.descriptor,
    path: staged.file,
  })
  return { root, registry, installer, staged, installRequest, envelope }
}

async function installStaged(context: Awaited<ReturnType<typeof setup>>, version = "1.0.0") {
  const payload = await context.staged(version)
  const prepared = await context.installer.prepareRelease(context.installRequest, context.envelope(payload))
  expect(prepared.registryUpgrade).toEqual({ from: 2, to: 3 })
  const committed = await context.installer.commit(prepared.operationId, prepared.token, {
    acceptRegistryUpgrade: true,
  })
  expect(committed.committed).toBe(true)
  return payload
}

describe("private staged release installation", () => {
  test("staged release installs from local bytes without network and persists a durable release source", async () => {
    const context = await setup({
      resolveRelease: async () => {
        throw new Error("NETWORK_BLOCKED https://user:password@example.com/?secret")
      },
      download: async () => {
        throw new Error("NETWORK_BLOCKED")
      },
    })
    const payload = await context.staged()
    const prepared = await context.installer.prepareRelease(context.installRequest, context.envelope(payload))
    expect(prepared.source).toMatchObject({
      type: "release",
      descriptor: releaseURL,
      extensionID: id,
      version: "1.0.0",
      // Query data of the artifact URL is hidden from the durable source.
      artifact: "https://cdn.example.com/extension.tgz",
      sha256: sha(payload.bytes),
      descriptorSha256: sha(Buffer.from(payload.descriptor, "utf8")),
    })
    const metadata = await readFile(path.join(context.root, "staging", prepared.operationId, "operation.json"), "utf8")
    expect(metadata).not.toContain("PRIVATE")
    const committed = await context.installer.commit(prepared.operationId, prepared.token, {
      acceptRegistryUpgrade: true,
    })
    expect(committed.committed).toBe(true)
    const row = (await Registry.snapshot(id, context.registry)).row
    expect(row?.source).toMatchObject({
      type: "release",
      descriptor: releaseURL,
      version: "1.0.0",
      artifact: "https://cdn.example.com/extension.tgz",
      sha256: sha(payload.bytes),
    })
    expect(JSON.stringify(row)).not.toContain("PRIVATE")
  })

  test("release-current update must reuse the installed release descriptor URL", async () => {
    const context = await setup()
    const payload = await installStaged(context)
    // Same descriptor reinstalls the same version without changing the source.
    const update = await context.installer.prepareRelease(
      { kind: "update", id, target: "release-current" },
      context.envelope(payload),
    )
    expect(update.kind).toBe("update")
    expect(update.versionChange).toBe("same-version")
    expect(update.source).toMatchObject({ type: "release", descriptor: releaseURL, version: "1.0.0" })
    const committed = await context.installer.commit(update.operationId, update.token)
    expect(committed.committed).toBe(true)
    const row = (await Registry.snapshot(id, context.registry)).row
    expect(row?.source).toMatchObject({ type: "release", descriptor: releaseURL })
    expect(row?.version).toBe("1.0.0")

    // A different descriptor URL cannot hijack the installed source.
    const hijack = await context.installer
      .prepareRelease(
        { kind: "update", id, target: "release-current" },
        context.envelope(payload, "https://example.com/other.json"),
      )
      .catch((error: unknown) => error)
    expect(hijack).toBeInstanceOf(InstallError)
    expect(String((hijack as Error).message)).toMatch(/source mismatch/i)
    // An explicit source update is not the staged release-current channel.
    const explicit = await context.installer
      .prepareRelease(
        { kind: "update", id, source: { type: "release", url: releaseURL } } as never,
        context.envelope(payload),
      )
      .catch((error: unknown) => error)
    expect(explicit).toBeInstanceOf(InstallError)
    expect((await Registry.snapshot(id, context.registry)).row?.source).toMatchObject({ descriptor: releaseURL })
  })

  test("staged artifact hash, descriptor identity and schema mismatches are rejected without registry change", async () => {
    const context = await setup()
    const payload = await context.staged()
    const install = context.installRequest
    // Artifact digest does not match the staged bytes.
    const wrongDigest = await context.staged("1.0.0", id, "b".repeat(64))
    await expect(context.installer.prepareRelease(install, context.envelope(wrongDigest))).rejects.toThrow(
      /SHA-256|integrity/i,
    )
    // Descriptor identity does not match the packaged manifest.
    const wrongID = await context.staged("1.0.0", "test.other-release")
    await expect(context.installer.prepareRelease(install, context.envelope(wrongID))).rejects.toThrow(
      /identity mismatch/i,
    )
    // Descriptor version does not match the packaged manifest.
    const wrongVersion = { ...payload, descriptor: descriptor(payload.bytes, "9.0.0") }
    await expect(context.installer.prepareRelease(install, context.envelope(wrongVersion))).rejects.toThrow(
      /identity mismatch/i,
    )
    // Descriptor schema drift and malformed JSON never reach a prepared state.
    const drift = {
      ...payload,
      descriptor: JSON.stringify({
        schemaVersion: 1,
        id,
        version: "1.0.0",
        artifact: { url: artifactURL, sha256: sha(payload.bytes) },
        extra: "field",
      }),
    }
    await expect(context.installer.prepareRelease(install, context.envelope(drift))).rejects.toThrow(
      /descriptor|schema/i,
    )
    const malformed = { ...payload, descriptor: "{not-json" }
    await expect(context.installer.prepareRelease(install, context.envelope(malformed))).rejects.toThrow(/descriptor/i)
    // Descriptor over the 64 KiB bound is rejected before parsing.
    const oversized = { ...payload, descriptor: `${payload.descriptor}${" ".repeat(70_000)}` }
    await expect(context.installer.prepareRelease(install, context.envelope(oversized))).rejects.toThrow(/64 KiB/i)
    // The staged request URL must match the requested release source.
    await expect(
      context.installer.prepareRelease(install, context.envelope(payload, "https://example.com/other.json")),
    ).rejects.toThrow(/release/i)
    // A staged envelope never applies to removals.
    await expect(
      context.installer.prepareRelease({ kind: "uninstall", id } as never, context.envelope(payload)),
    ).rejects.toBeInstanceOf(InstallError)
    expect((await Registry.snapshot(id, context.registry)).row).toBeUndefined()
    expect((await Registry.snapshot(id, context.registry)).registryVersion).toBe(2)
  })
})

describe("private staged archive installation", () => {
  test("retains the original HTTPS URL through preview, commit and update", async () => {
    const context = await setup({
      download: async () => {
        throw new Error("must not use network")
      },
    })
    const first = await context.staged()
    const url = "https://downloads.example.com/viewer-1.tgz?private=secret"
    const preview = await context.installer.prepareArchive(
      { kind: "install", source: { type: "archive", url } },
      { path: first.file },
    )
    expect(preview.source).toEqual({
      type: "archive",
      location: "https://downloads.example.com/viewer-1.tgz",
      sha256: sha(first.bytes),
    })
    expect((await context.installer.commit(preview.operationId, preview.token)).committed).toBe(true)
    const next = await context.staged("2.0.0")
    const update = await context.installer.prepareArchive(
      {
        kind: "update",
        id,
        source: { type: "archive", url: "https://downloads.example.com/viewer-2.tgz", sha256: sha(next.bytes) },
      },
      { path: next.file },
    )
    expect((await context.installer.commit(update.operationId, update.token)).committed).toBe(true)
    expect((await Registry.snapshot(id, context.registry)).row?.source).toEqual({
      type: "archive",
      location: "https://downloads.example.com/viewer-2.tgz",
      sha256: sha(next.bytes),
    })
  })
  test("rejects a digest mismatch and unsupported source types", async () => {
    const context = await setup()
    const first = await context.staged()
    await expect(
      context.installer.prepareArchive(
        { kind: "install", source: { type: "archive", url: "https://example.com/a.tgz", sha256: "b".repeat(64) } },
        { path: first.file },
      ),
    ).rejects.toThrow(/SHA-256|integrity/)
    await expect(context.installer.prepareArchive(context.installRequest, { path: first.file })).rejects.toThrow(
      /Invalid staged archive/,
    )
  })
})

describe("public HTTP never accepts the staged release envelope", () => {
  const operationId = "00000000-0000-4000-8000-000000000001"
  const token = `${"a".repeat(64)}.${"b".repeat(64)}`
  const context = Context.empty() as Context.Context<unknown>
  const request = (pathname: string, body?: unknown) =>
    HttpApiApp.webHandler().handler(
      new Request(`http://localhost${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencode-extension-token": token },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      context,
    )

  test("staged release and hidden local fields are rejected before the installer is reached", async () => {
    let calls = 0
    installExtensionInstallAdapter({
      async prepare() {
        calls++
        throw new Error("installer must not be reached")
      },
    } as InstallationService)
    const release = { url: releaseURL, descriptor: "{}", path: "/tmp/private.tgz" }
    for (const body of [
      { kind: "install", source: { type: "release", url: releaseURL }, release },
      {
        kind: "install",
        source: { type: "archive", url: "https://example.com/a.tgz" },
        archive: { path: "/tmp/private.tgz" },
      },
      { kind: "install", source: { type: "release", url: releaseURL }, staged: release },
      { kind: "update", id, target: "release-current", release },
      { kind: "install", source: { type: "local", path: "/tmp/private.tgz", sha256: "c".repeat(64) } },
      { kind: "install", source: { type: "release", url: releaseURL, path: "/tmp/private.tgz" } },
      { kind: "install", source: { type: "archive", url: "https://example.com/a.tgz", path: "/tmp/private.tgz" } },
    ]) {
      const response = await request("/global/extension/prepare", body)
      expect(response.status).toBe(400)
    }
    expect(calls).toBe(0)
  })

  test("a legitimate release request still prepares over public HTTP", async () => {
    installExtensionInstallAdapter({
      async prepare(input) {
        return {
          operationId,
          token,
          expiresAt: Date.now() + 60_000,
          kind: input.kind,
          id,
          name: "private-release",
          version: "1.0.0",
          permissions: [],
          permissionsAdded: [],
          permissionsRemoved: [],
          contributes: {},
          source: {
            type: "release",
            descriptor: releaseURL,
            extensionID: id,
            version: "1.0.0",
            artifact: "https://cdn.example.com/extension.tgz",
            sha256: "c".repeat(64),
            descriptorSha256: "d".repeat(64),
          },
          hasServer: true,
          enable: false,
        } as never
      },
    })
    const response = await request("/global/extension/prepare", {
      kind: "install",
      source: { type: "release", url: releaseURL },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ source: { type: "release", descriptor: releaseURL } })
  })

  test("pure mode blocks the installation endpoints before the adapter", async () => {
    installExtensionInstallAdapter({} as InstallationService)
    const handler = HttpRouter.toWebHandler(
      HttpApiApp.createRoutes().pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_PURE: true }))),
      ),
      { disableLogger: true },
    ).handler
    const response = await handler(
      new Request("http://localhost/global/extension/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "install", source: { type: "release", url: releaseURL }, staged: {} }),
      }),
      context,
    )
    expect(response.status).toBe(403)
  })
})
