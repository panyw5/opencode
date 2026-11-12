import { expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import tar from "tar-stream"
import { Global } from "@opencode-ai/core/global"
import { installation } from "../../src/extension/install-service"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionRuntime } from "../../src/extension/runtime"
import { ExtensionID } from "../../src/extension/schema"

// Deliberately red against the audited lifecycle. Enable explicitly until its replacement lands.
const target = test.skipIf(process.env.OPENCODE_EXTENSION_LIFECYCLE_TARGET !== "1")

function assertTestStorage() {
  const home = process.env.OPENCODE_TEST_HOME
  if (!home || path.basename(path.dirname(home)) !== `opencode-test-data-${process.pid}`) {
    throw new Error("Lifecycle target tests require the package's isolated test/preload.ts")
  }
  for (const directory of [Global.Path.data, Global.Path.cache]) {
    const relative = path.relative(path.dirname(home), directory)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Lifecycle target tests refuse non-test data/cache storage")
    }
  }
}

async function setup() {
  assertTestStorage()
  const id = ExtensionID.make(`test.lifecycle-${randomUUID()}`)
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc-lifecycle-target-")))
  const registry = path.join(root, "registry.json")
  const original = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registry
  const installer = installation()
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

  async function source(version: string, failActivation = false) {
    const pack = tar.pack()
    const chunks: Buffer[] = []
    const read = (async () => {
      for await (const chunk of pack) chunks.push(Buffer.from(chunk))
    })()
    pack.entry(
      { name: "package/package.json" },
      JSON.stringify({
        name: "lifecycle-target-fixture",
        version,
        type: "module",
        exports: { "./server": "./server.js" },
        opencode: {
          manifestVersion: 1,
          id,
          displayName: "Lifecycle target fixture",
          contributes: { settings: { apiKey: { type: "string", title: "Key", secret: true } } },
        },
      }),
    )
    pack.entry(
      { name: "package/server.js" },
      `
export default {
  id: ${JSON.stringify(id)},
  async activate() {
    ${failActivation ? 'throw new Error("fixture readiness rejected")' : `return { rpc: { version: async () => ${JSON.stringify(version)} }, dispose: async () => {} }`}
  }
}
`,
    )
    pack.finalize()
    await read
    const bytes = gzipSync(Buffer.concat(chunks))
    // Stable local location preserves the current archive-update authorization rules.
    const file = path.join(root, "candidate.tgz")
    await writeFile(file, bytes)
    return { type: "local" as const, path: file, sha256: sha(bytes) }
  }

  async function install(enable = true) {
    const prepared = await installer.prepare({ kind: "install", source: await source("1.0.0") })
    const result = await installer.commit(prepared.operationId, prepared.token, { enable })
    expect(result.committed).toBe(true)
    if (enable) expect(await ExtensionRuntime.rpc({ id, method: "version" })).toBe("1.0.0")
    return (await ExtensionRegistry.snapshot(id, registry)).row!
  }

  return {
    id,
    root,
    registry,
    installer,
    source,
    install,
    async [Symbol.asyncDispose]() {
      try {
        // The existing runtime deliberately retains pins until this test-only reset.
        // Reset is teardown, never evidence that production uninstall released them.
        await ExtensionRuntime.testing.reset()
        await installer.close()
      } finally {
        if (original === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
        else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = original
        await Promise.all(
          [
            root,
            path.join(Global.Path.data, "extensions", "data", id),
            path.join(Global.Path.data, "extensions", "data-ownership", `${id}.json`),
            path.join(Global.Path.cache, "extensions", id),
            path.join(Global.Path.tmp, "extension-modules", id),
          ].map((directory) => rm(directory, { recursive: true, force: true })),
        )
      }
    },
  }
}

test("lifecycle fixture refuses data access without the isolated test preload", () => {
  const original = process.env.OPENCODE_TEST_HOME
  try {
    delete process.env.OPENCODE_TEST_HOME
    expect(assertTestStorage).toThrow("isolated test/preload.ts")
  } finally {
    if (original === undefined) delete process.env.OPENCODE_TEST_HOME
    else process.env.OPENCODE_TEST_HOME = original
  }
})

test("lifecycle fixture rejects a corrupt candidate without modifying the active installation", async () => {
  await using f = await setup()
  const first = await f.install(false)
  const candidate = await f.source("2.0.0")
  await writeFile(candidate.path, "corrupted candidate")
  await expect(f.installer.prepare({ kind: "update", id: f.id, source: candidate })).rejects.toThrow()
  expect((await ExtensionRegistry.snapshot(f.id, f.registry)).row).toEqual(first)
})

target("target: default uninstall removes retained settings and secret ownership", async () => {
  await using f = await setup()
  await f.install(false)
  await ExtensionRegistry.updateSettings(f.id, { apiKey: "fixture-secret-not-a-credential" })
  const prepared = await f.installer.prepare({ kind: "uninstall", id: f.id })
  await f.installer.commit(prepared.operationId, prepared.token)
  const snapshot = await ExtensionRegistry.snapshot(f.id, f.registry)
  expect(snapshot.row).toBeUndefined()
  expect(snapshot.retained).toBeUndefined()
})

target("target: uninstall of an activated extension deletes its generation and owned data", async () => {
  await using f = await setup()
  const row = await f.install()
  const data = path.join(Global.Path.data, "extensions", "data", f.id)
  await mkdir(data, { recursive: true, mode: 0o700 })
  await writeFile(path.join(data, "owned.txt"), "owned fixture data")
  const prepared = await f.installer.prepare({ kind: "uninstall", id: f.id })
  await f.installer.commit(prepared.operationId, prepared.token)
  await expect(ExtensionRuntime.rpc({ id: f.id, method: "version" })).rejects.toThrow()
  expect({
    generationExists: await Bun.file(path.join(row.dir, "server.js")).exists(),
    dataExists: await Bun.file(path.join(data, "owned.txt")).exists(),
  }).toEqual({ generationExists: false, dataExists: false })
})

target("target: successful update routes B and actually collects activated generation A", async () => {
  await using f = await setup()
  const previous = await f.install()
  const prepared = await f.installer.prepare({ kind: "update", id: f.id, source: await f.source("2.0.0") })
  await f.installer.commit(prepared.operationId, prepared.token)
  expect(await ExtensionRuntime.rpc({ id: f.id, method: "version" })).toBe("2.0.0")
  expect(await Bun.file(path.join(previous.dir, "server.js")).exists()).toBe(false)
})

target("target: activation failure of B restores A rather than accepting B", async () => {
  await using f = await setup()
  await f.install()
  const prepared = await f.installer.prepare({ kind: "update", id: f.id, source: await f.source("2.0.0", true) })
  await f.installer.commit(prepared.operationId, prepared.token)
  const running = await ExtensionRuntime.rpc({ id: f.id, method: "version" }).then(
    (version) => ({ ok: true, version }),
    () => ({ ok: false }),
  )
  expect((await ExtensionRegistry.snapshot(f.id, f.registry)).row?.version).toBe("1.0.0")
  expect(running).toEqual({ ok: true, version: "1.0.0" })
})

target("target: archive uninstall followed by release install is not vetoed by retained source", async () => {
  await using f = await setup()
  await f.install(false)
  const remove = await f.installer.prepare({ kind: "uninstall", id: f.id })
  await f.installer.commit(remove.operationId, remove.token)
  const archive = await f.source("1.0.0")
  const descriptor = JSON.stringify({
    schemaVersion: 1,
    id: f.id,
    version: "1.0.0",
    artifact: { url: "https://example.com/fixture.tgz", sha256: archive.sha256 },
  })
  const prepared = await f.installer.prepareRelease(
    { kind: "install", source: { type: "release", url: "https://example.com/stable.json" } },
    { url: "https://example.com/stable.json", descriptor, path: archive.path },
  )
  const result = await f.installer.commit(prepared.operationId, prepared.token, { acceptRegistryUpgrade: true })
  expect(result.committed).toBe(true)
  expect((await ExtensionRegistry.snapshot(f.id, f.registry)).retained).toBeUndefined()
})
