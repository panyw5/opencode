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

  test("preserves optional viewer content ownership and rejects unknown values", async () => {
    await using tmp = await tmpdir()
    for (const content of [undefined, "text", "self"] as const) {
      const root = await extensionPackage(tmp.path, {
        id: `test.content-${content ?? "legacy"}`,
        fileViewers: [{ id: "hello", title: "Hello", extensions: ["hello"], ...(content ? { content } : {}) }],
      })
      expect((await load(root)).contributes.fileViewers?.[0].content).toBe(content)
    }
    const invalid = await extensionPackage(tmp.path, {
      id: "test.content-invalid",
      fileViewers: [{ id: "hello", title: "Hello", extensions: ["hello"], content: "binary" }],
    })
    await expect(load(invalid)).rejects.toThrow()
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

  test("loads a server-only extension without web parts", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path, {
      id: "test.server-only",
      webExport: null,
      webManifest: false,
      activation: null,
      fileViewers: null,
      serverEntry: "dist/server.js",
    })

    const manifest = await load(root)
    expect(manifest.serverEntry).toBe("dist/server.js")
    expect(manifest.entry).toBeUndefined()
    expect(manifest.styles).toEqual([])
    expect(manifest.versionSegment).toMatch(/^1\.2\.3-[a-f0-9]{12}$/)
    expect(manifest.webFingerprint).toMatch(/^[a-f0-9]{40}$/)
    expect(manifest.serverFingerprint).toMatch(/^[a-f0-9]{40}$/)
  })

  test("requires at least one web or server entry", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path, {
      id: "test.no-entry",
      webExport: null,
      webManifest: false,
      activation: null,
      fileViewers: null,
    })
    await expect(load(root)).rejects.toThrow('must expose exports["./web"] or exports["./server"]')
  })

  test("rejects web manifest and export inconsistencies", async () => {
    await using tmp = await tmpdir()
    const missingSection = await extensionPackage(tmp.path, {
      id: "test.web-no-manifest",
      webManifest: false,
      activation: null,
      fileViewers: null,
    })
    await expect(load(missingSection)).rejects.toThrow('requires opencode.web when exports["./web"]')

    const missingExport = await extensionPackage(tmp.path, {
      id: "test.web-no-export",
      webExport: null,
      activation: null,
      fileViewers: null,
      serverEntry: "dist/server.js",
    })
    await expect(load(missingExport)).rejects.toThrow("declares opencode.web but the package does not expose")
  })

  test("rejects a server entry outside the package directory", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "escape.js"), "export default {}")
    const root = await extensionPackage(tmp.path, {
      id: "test.server-escape",
      webExport: null,
      webManifest: false,
      activation: null,
      fileViewers: null,
      serverEntry: "dist/server.js",
      serverExport: "../escape.js",
    })
    await expect(load(root)).rejects.toThrow("outside plugin directory")
  })

  test("keeps web and server fingerprints independent", async () => {
    await using tmp = await tmpdir()
    const root = await extensionPackage(tmp.path, { id: "test.fingerprints", serverEntry: "dist/server.js" })

    const before = await load(root)
    await Bun.write(path.join(root, "dist/server.js"), "export default { changed: true }\n")
    const after = await load(root)

    expect(after.versionSegment).toBe(before.versionSegment)
    expect(after.serverFingerprint).not.toBe(before.serverFingerprint)
    expect(after.webFingerprint).toBe(before.webFingerprint)
  })

  test("validates setting definitions", async () => {
    await using tmp = await tmpdir()
    const valid = await extensionPackage(tmp.path, {
      id: "test.settings",
      activation: ["onStartup"],
      fileViewers: null,
      settings: {
        wolframscriptPath: { type: "string", title: "Path", default: "" },
        exposeTool: { type: "string", title: "Expose", enum: ["always", "never"], default: "always" },
        level: { type: "number", title: "Level", default: 1 },
        debug: { type: "boolean", title: "Debug" },
      },
    })
    const manifest = await load(valid)
    expect(manifest.contributes.settings?.exposeTool.default).toBe("always")

    const defaultMismatch = await extensionPackage(tmp.path, {
      id: "test.settings-default",
      activation: ["onStartup"],
      fileViewers: null,
      settings: { broken: { type: "string", title: "Broken", default: 3 } },
    })
    await expect(load(defaultMismatch)).rejects.toThrow("default that does not match its type")

    const enumMismatch = await extensionPackage(tmp.path, {
      id: "test.settings-enum",
      activation: ["onStartup"],
      fileViewers: null,
      settings: { broken: { type: "string", title: "Broken", enum: ["a", 2] } },
    })
    await expect(load(enumMismatch)).rejects.toThrow("enum values that do not match its type")

    const booleanEnum = await extensionPackage(tmp.path, {
      id: "test.settings-boolean-enum",
      activation: ["onStartup"],
      fileViewers: null,
      settings: { broken: { type: "boolean", title: "Broken", enum: ["a"] } },
    })
    await expect(load(booleanEnum)).rejects.toThrow("must not declare enum values for boolean type")

    const defaultNotInEnum = await extensionPackage(tmp.path, {
      id: "test.settings-default-enum",
      activation: ["onStartup"],
      fileViewers: null,
      settings: { broken: { type: "string", title: "Broken", enum: ["a", "b"], default: "c" } },
    })
    await expect(load(defaultNotInEnum)).rejects.toThrow("not one of its enum values")
  })

  test("validates tool, command and panel activations and uniqueness", async () => {
    await using tmp = await tmpdir()
    const valid = await extensionPackage(tmp.path, {
      id: "test.contributions",
      activation: ["onTool:wolfram_eval", "onCommand:restart", "onPanel:notes"],
      fileViewers: null,
      toolRenderers: [{ tool: "wolfram_eval" }],
      commands: [{ id: "restart", title: "Restart" }],
      panels: [{ id: "notes", title: "Notes" }],
    })
    const manifest = await load(valid)
    expect(manifest.activation).toEqual(["onTool:wolfram_eval", "onCommand:restart", "onPanel:notes"])

    const unknownTool = await extensionPackage(tmp.path, {
      id: "test.unknown-tool",
      activation: ["onTool:missing"],
      fileViewers: null,
      toolRenderers: [{ tool: "wolfram_eval" }],
    })
    await expect(load(unknownTool)).rejects.toThrow("unknown tool")

    const unknownCommand = await extensionPackage(tmp.path, {
      id: "test.unknown-command",
      activation: ["onCommand:missing"],
      fileViewers: null,
      commands: [{ id: "restart", title: "Restart" }],
    })
    await expect(load(unknownCommand)).rejects.toThrow("unknown command")

    const unknownPanel = await extensionPackage(tmp.path, {
      id: "test.unknown-panel",
      activation: ["onPanel:missing"],
      fileViewers: null,
      panels: [{ id: "notes", title: "Notes" }],
    })
    await expect(load(unknownPanel)).rejects.toThrow("unknown panel")

    const duplicateCommand = await extensionPackage(tmp.path, {
      id: "test.duplicate-command",
      activation: ["onStartup"],
      fileViewers: null,
      commands: [
        { id: "restart", title: "A" },
        { id: "restart", title: "B" },
      ],
    })
    await expect(load(duplicateCommand)).rejects.toThrow("duplicate command id")

    const duplicateRenderer = await extensionPackage(tmp.path, {
      id: "test.duplicate-renderer",
      activation: ["onStartup"],
      fileViewers: null,
      toolRenderers: [{ tool: "wolfram_eval" }, { tool: "wolfram_eval" }],
    })
    await expect(load(duplicateRenderer)).rejects.toThrow("duplicate tool renderer")
  })
})
