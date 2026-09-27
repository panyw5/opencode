import { describe, expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../fixture/fixture"
import { extensionPackage } from "./fixture"
import { CompatibilityError, load } from "../../src/extension/manifest"

describe("extension manifest", () => {
  test("loads a valid web extension and computes safe relative assets", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path, {
      styles: ["dist/web/index.css"],
      icon: "dist/web/icon.svg",
      webExport: { import: "./dist/web/index.js" },
    })

    const manifest = await load(root)
    expect(manifest.id).toBe("test.extension")
    expect(manifest.entry).toBe("index.js")
    expect(manifest.styles).toEqual(["index.css"])
    expect(manifest.icon).toBe("icon.svg")
    expect(manifest.versionSegment).toMatch(/^1\.2\.3-[a-f0-9]{12}$/)
  })

  test("rejects ids, duplicate viewers, missing matchers and unknown activations", async () => {
    await using tmp = await tmpdir()
    const invalid = await extensionPackage(tmp.path, { id: "Invalid" })
    await expect(load(invalid)).rejects.toThrow()

    const dup = await extensionPackage(tmp.path, {
      id: "test.duplicate",
      fileViewers: [
        { id: "hello", title: "A", extensions: ["a"] },
        { id: "hello", title: "B", extensions: ["b"] },
      ],
    })
    await expect(load(dup)).rejects.toThrow("duplicate file viewer")

    const empty = await extensionPackage(tmp.path, {
      id: "test.empty",
      fileViewers: [{ id: "hello", title: "A" }],
    })
    await expect(load(empty)).rejects.toThrow("has no matchers")

    const unknown = await extensionPackage(tmp.path, {
      id: "test.unknown",
      activation: ["onFileViewer:missing"],
    })
    await expect(load(unknown)).rejects.toThrow("unknown file viewer")
  })

  test("rejects exports and assets outside the package or web root", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "escape.js"), "export default {}")
    const escapedEntry = await extensionPackage(tmp.path, {
      id: "test.entry",
      webExport: "../escape.js",
    })
    await expect(load(escapedEntry)).rejects.toThrow("outside plugin directory")

    const escapedStyle = await extensionPackage(tmp.path, {
      id: "test.style",
      styles: ["dist/outside.css"],
    })
    await mkdir(path.join(escapedStyle, "dist"), { recursive: true })
    await Bun.write(path.join(escapedStyle, "dist/outside.css"), ".outside {}")
    await expect(load(escapedStyle)).rejects.toThrow("outside web root")
  })

  test("marks incompatible engine ranges with a dedicated error", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path, { id: "test.incompatible", engines: ">=999.0.0" })
    await expect(load(root, { opencodeVersion: "1.18.49" })).rejects.toBeInstanceOf(CompatibilityError)
  })
})
