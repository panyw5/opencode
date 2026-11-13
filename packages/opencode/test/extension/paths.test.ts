import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import {
  assertDevelopmentDirectory,
  generationPath,
  ownedGeneration,
  privateDirectory,
} from "../../src/extension/paths"
import { generationOwnership } from "../../src/extension/cleanup"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionRuntime, type Options } from "../../src/extension/runtime"
import { ExtensionID } from "../../src/extension/schema"
import { extensionPackage } from "./fixture"
import type { RegistryRow } from "../../src/extension/schema"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc-ext-paths-")))
  roots.push(root)
  return root
}

test("generation identity cannot escape managed storage", async () => {
  const root = await fixture()
  const registry = path.join(root, "registry.json")
  expect(() => generationPath(registry, "../outside")).toThrow("identity")
  expect(() => generationPath(registry, "/absolute")).toThrow("identity")
  expect(generationPath(registry, randomUUID())).toStartWith(path.join(root, "packages"))
})

test("owned installations require a real package directory and never own path links", async () => {
  const root = await fixture()
  const registry = path.join(root, "registry.json")
  const installId = randomUUID()
  const generation = generationPath(registry, installId)
  const directory = path.join(generation, "package")
  await mkdir(directory, { recursive: true })
  const row: RegistryRow = {
    name: "example",
    version: "1.0.0",
    enabled: false,
    installedAt: 0,
    installId,
    source: { type: "archive", location: "https://example.com/a.tgz", sha256: "a".repeat(64) },
    dir: directory,
  }
  expect(await ownedGeneration(registry, row)).toBe(generation)
  expect(await ownedGeneration(registry, { ...row, source: { type: "path", path: directory } })).toBeUndefined()
  await expect(ownedGeneration(registry, { ...row, dir: root })).rejects.toThrow("outside")
  await rm(directory, { recursive: true })
  const external = path.join(root, "outside")
  await mkdir(external)
  await writeFile(path.join(external, "keep"), "untouched")
  await symlink(external, directory, "dir")
  await expect(ownedGeneration(registry, row)).rejects.toThrow("owned")
})

test("private storage rejects symlink ancestors", async () => {
  const root = await fixture()
  const external = path.join(root, "external")
  await mkdir(external)
  const link = path.join(root, "link")
  await symlink(external, link, "dir")
  await expect(privateDirectory(path.join(link, "child"))).rejects.toThrow("symbolic")
})

test("managed copies cannot be newly linked or loaded through another registry's legacy path row", async () => {
  const root = await fixture()
  const registryA = path.join(root, "a", "registry.json")
  const registryB = path.join(root, "b", "registry.json")
  const installId = randomUUID()
  const generation = generationPath(registryA, installId)
  await mkdir(generation, { recursive: true, mode: 0o700 })
  const candidate = await extensionPackage(generation, { id: "test.managed-link", serverEntry: "server.js" })
  await writeFile(
    path.join(generation, "installation.json"),
    JSON.stringify(
      generationOwnership(registryA, {
        operationId: randomUUID(),
        installId,
        id: "test.managed-link",
        name: "test-extension",
        contentHash: "a".repeat(64),
        createdAt: Date.now(),
      }),
    ),
    { mode: 0o600 },
  )
  await expect(assertDevelopmentDirectory(candidate)).rejects.toThrow("Managed extension copies")
  await expect(ExtensionRegistry.link(candidate, undefined, registryB)).rejects.toThrow("Managed extension copies")
  await mkdir(path.dirname(registryB), { recursive: true })
  const id = ExtensionID.make("test.managed-link")
  await writeFile(
    registryB,
    JSON.stringify({
      version: 2,
      revision: 1,
      extensions: {
        [id]: {
          name: "test-extension",
          version: "1.2.3",
          source: { type: "path", path: candidate },
          dir: candidate,
          enabled: true,
          installedAt: 0,
        },
      },
    }),
  )
  const previous = process.env.OPENCODE_EXTENSION_REGISTRY_FILE
  let imported = false
  process.env.OPENCODE_EXTENSION_REGISTRY_FILE = registryB
  const options: Options = {}
  options.importer = (async () => {
    imported = true
    return { activate: async () => ({ rpc: { ping: () => "wrong" } }) }
  })
  const rt = ExtensionRuntime.make(options)
  try {
    await expect(rt.rpc({ id, method: "ping" })).rejects.toThrow("Managed extension copies")
    expect(imported).toBe(false)
  } finally {
    await rt.testing.reset()
    if (previous === undefined) delete process.env.OPENCODE_EXTENSION_REGISTRY_FILE
    else process.env.OPENCODE_EXTENSION_REGISTRY_FILE = previous
  }
  const source = await extensionPackage(path.join(root, "source"))
  await expect(assertDevelopmentDirectory(source)).resolves.toBeUndefined()
})
