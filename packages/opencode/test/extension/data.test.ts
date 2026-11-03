import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { provisionData, quarantineData } from "../../src/extension/data"
import { ExtensionID } from "../../src/extension/schema"

const ids: string[] = []
afterEach(async () => {
  for (const id of ids.splice(0)) {
    await rm(path.join(Global.Path.data, "extensions", "data", id), { recursive: true, force: true })
    await rm(path.join(Global.Path.cache, "extensions", id), { recursive: true, force: true })
    await rm(path.join(Global.Path.data, "extensions", "data-ownership", `${id}.json`), { force: true })
    await rm(path.join(Global.Path.data, "extensions", "data-purge", `${id}.json`), { force: true })
  }
})
function identity() {
  const id = `test.data-${randomUUID()}`
  ids.push(id)
  return {
    id,
    name: "data-fixture",
    source: { type: "archive" as const, location: "https://example.com/fixture.tgz", sha256: "a".repeat(64) },
  }
}

test("new managed data is owned by source identity and safely quarantined before deletion", async () => {
  const value = identity()
  await provisionData(value)
  await provisionData(value)
  const data = path.join(Global.Path.data, "extensions", "data", value.id)
  const cache = path.join(Global.Path.cache, "extensions", value.id)
  await mkdir(data, { recursive: true })
  await mkdir(cache, { recursive: true })
  await writeFile(path.join(data, "secret"), "private")
  await writeFile(path.join(cache, "entry"), "cached")
  const moved = await quarantineData(value)
  expect(await Bun.file(path.join(data, "secret")).exists()).toBe(false)
  expect(await Bun.file(path.join(cache, "entry")).exists()).toBe(false)
  expect(await moved.finish()).toBe(true)
})

test("a different source cannot provision or purge existing managed data", async () => {
  const value = identity()
  await provisionData(value)
  const data = path.join(Global.Path.data, "extensions", "data", value.id)
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, "keep"), "private")
  const different = { ...value, source: { ...value.source, location: "https://other.example/fixture.tgz" } }
  await expect(provisionData(different)).rejects.toThrow("another source")
  await expect(quarantineData(different)).rejects.toThrow("ownership")
  expect(await readFile(path.join(data, "keep"), "utf8")).toBe("private")
})

test("an empty namespace still preserves ownership from another registry's source", async () => {
  const value = identity()
  await provisionData(value)
  const owner = path.join(Global.Path.data, "extensions", "data-ownership", `${value.id}.json`)
  const before = await readFile(owner, "utf8")
  const different = { ...value, source: { ...value.source, location: "https://other.example/fixture.tgz" } }
  await expect(quarantineData(different)).rejects.toThrow("ownership")
  expect(await readFile(owner, "utf8")).toBe(before)
  await expect(provisionData(different)).rejects.toThrow("another source")
  const moved = await quarantineData(value)
  expect(await moved.finish()).toBe(true)
})

test("release data ownership follows descriptor and extension id, never resolved artifact snapshots", async () => {
  const value = identity()
  const release = {
    ...value,
    source: {
      type: "release" as const,
      descriptor: "https://example.com/stable.json",
      extensionID: ExtensionID.make(value.id),
      version: "1.2.3",
      artifact: "https://cdn.example.com/extension.tgz",
      sha256: "a".repeat(64),
      descriptorSha256: "b".repeat(64),
    },
  }
  await provisionData(release)
  const data = path.join(Global.Path.data, "extensions", "data", value.id)
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, "keep"), "private")
  const owner = path.join(Global.Path.data, "extensions", "data-ownership", `${value.id}.json`)
  const before = await readFile(owner, "utf8")
  const updated = {
    ...release,
    source: {
      ...release.source,
      version: "2.0.0",
      artifact: "https://other-cdn.example.com/extension-2.tgz",
      sha256: "c".repeat(64),
      descriptorSha256: "d".repeat(64),
    },
  }
  await provisionData(updated)
  expect(await readFile(owner, "utf8")).toBe(before)
  for (const source of [
    { ...release.source, descriptor: "https://other.example.com/stable.json" },
    { ...release.source, extensionID: ExtensionID.make("test.other") },
    value.source,
  ]) {
    const different = { ...release, source }
    await expect(provisionData(different)).rejects.toThrow("another source")
    await expect(quarantineData(different)).rejects.toThrow("ownership")
    expect(await readFile(path.join(data, "keep"), "utf8")).toBe("private")
    expect(await readFile(owner, "utf8")).toBe(before)
  }
  const moved = await quarantineData(updated)
  expect(await moved.finish()).toBe(true)
})

test("legacy unowned data is never adopted or removed", async () => {
  const value = identity()
  const data = path.join(Global.Path.data, "extensions", "data", value.id)
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, "keep"), "legacy")
  await expect(provisionData(value)).rejects.toThrow("ownership")
  expect(await Bun.file(path.join(Global.Path.data, "extensions", "data-ownership", `${value.id}.json`)).exists()).toBe(
    false,
  )
  await expect(quarantineData(value)).rejects.toThrow()
  expect(await readFile(path.join(data, "keep"), "utf8")).toBe("legacy")
})

test("quarantined data can resume after a crash without losing the deletion journal", async () => {
  const value = identity()
  await provisionData(value)
  const data = path.join(Global.Path.data, "extensions", "data", value.id)
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, "private"), "secret")
  await quarantineData(value) // Simulates process exit before recursive finish.
  const pending = path.join(Global.Path.data, "extensions", "data-purge", `${value.id}.json`)
  expect(await Bun.file(pending).exists()).toBe(true)
  await expect(provisionData(value)).rejects.toThrow("purge")
  const resumed = await quarantineData(value)
  expect(resumed.cleanupPending).toBe(true)
  expect(await resumed.finish()).toBe(true)
  expect(await Bun.file(pending).exists()).toBe(false)
})
