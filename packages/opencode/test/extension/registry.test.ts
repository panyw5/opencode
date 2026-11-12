import { afterAll, afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { extensionPackage } from "./fixture"
import { ExtensionRegistry } from "../../src/extension/registry"
import { ExtensionID } from "../../src/extension/schema"

const root = await mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "oc-ext-reg-suite-"))
const registry = path.join(root, "registry.json")
const base = (manifest: { id: string; versionSegment: string }) =>
  `/extension-asset/token/${manifest.id}/${manifest.versionSegment}/`

afterEach(() => rm(registry, { force: true }))
afterAll(() => rm(root, { recursive: true, force: true }))

describe("extension registry", () => {
  test("links, lists, disables and preserves state across relink", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)

    const linked = await ExtensionRegistry.link(extension, base, registry)
    expect(linked.id).toBe("test.extension")
    expect(linked.state).toBe("ready")
    expect(linked.web?.base).toContain("/extension-asset/token/")
    expect(linked.web?.styles).toEqual([])

    const id = ExtensionID.make("test.extension")
    expect((await ExtensionRegistry.list(base, registry)).map((item) => item.id)).toEqual(["test.extension"])
    expect((await ExtensionRegistry.setEnabled(id, false, base, registry)).state).toBe("disabled")
    expect((await ExtensionRegistry.link(extension, base, registry)).enabled).toBe(false)
    expect((await ExtensionRegistry.get(id, base, registry)).state).toBe("disabled")
  })

  test("isolates broken linked packages as error entries", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    await ExtensionRegistry.link(extension, base, registry)
    await Bun.write(path.join(extension, "package.json"), "{}")

    const [entry] = await ExtensionRegistry.list(base, registry)
    expect(entry?.state).toBe("error")
    expect(entry?.id).toBe("test.extension")
    expect(entry?.error).toContain("missing")
  })

  test("persists disable state even when the linked manifest is broken", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path)
    await ExtensionRegistry.link(extension, base, registry)
    await Bun.write(path.join(extension, "package.json"), "{}")

    const id = ExtensionID.make("test.extension")
    const disabled = await ExtensionRegistry.setEnabled(id, false, base, registry)
    expect(disabled.enabled).toBe(false)
    expect(disabled.state).toBe("error")
    const stored = await Bun.file(registry).json()
    expect(stored.extensions["test.extension"].enabled).toBe(false)
  })

  test("relinking a directory under a new id removes the stale row", async () => {
    await using tmp = await tmpdir()
    const extension = await extensionPackage(tmp.path, { id: "test.old" })
    await ExtensionRegistry.link(extension, base, registry)
    const json = await Bun.file(path.join(extension, "package.json")).json()
    json.opencode.id = "test.new"
    await Bun.write(path.join(extension, "package.json"), JSON.stringify(json, null, 2))

    await ExtensionRegistry.link(extension, base, registry)
    expect((await ExtensionRegistry.list(base, registry)).map((item) => item.id)).toEqual(["test.new"])
  })

  test("rejects malformed registry JSON and unknown ids", async () => {
    await Bun.write(registry, "{")
    await expect(ExtensionRegistry.list(base, registry)).rejects.toThrow("invalid JSON")

    await Bun.write(registry, JSON.stringify({ version: 1, extensions: {} }))
    await expect(ExtensionRegistry.setEnabled(ExtensionID.make("test.missing"), false, base, registry)).rejects.toThrow(
      "Extension not found",
    )
  })

  test("sorts entries by id", async () => {
    await using tmp = await tmpdir()
    const z = await extensionPackage(tmp.path, { id: "test.zed", name: "zed" })
    const a = await extensionPackage(tmp.path, { id: "test.alpha", name: "alpha" })
    await ExtensionRegistry.link(z, base, registry)
    await ExtensionRegistry.link(a, base, registry)
    expect((await ExtensionRegistry.list(base, registry)).map((item) => item.id)).toEqual(["test.alpha", "test.zed"])
  })
})
