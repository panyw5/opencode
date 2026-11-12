import { describe, expect, test } from "bun:test"
import type { ExtensionInfo } from "@/extensions/types"
import {
  catalogPick,
  extensionPick,
  extensionSelection,
  extensionSelectionKey,
  parseExtensionPick,
} from "./config-extensions"

const item = (id: string, settings = false): ExtensionInfo => ({
  id,
  displayName: id,
  version: "1.0.0",
  enabled: true,
  state: "ready",
  activation: [],
  contributes: settings ? { settings: { name: { type: "string", title: "Name" } } } : {},
})

describe("extension configuration selection", () => {
  test("uses a dedicated namespace rather than plugin document ids", () => {
    expect(extensionPick("test.viewer")).toBe("extension:test.viewer")
    expect(parseExtensionPick("extension:test.viewer")).toBe("test.viewer")
    expect(parseExtensionPick("plugin:test.viewer")).toBeUndefined()
    expect(parseExtensionPick("extension:")).toBeUndefined()
  })

  test("includes extensions without settings and keeps a valid selection", () => {
    const items = [item("test.viewer"), item("test.settings", true)]
    expect(extensionSelection(items, "extension:test.viewer")).toBe("extension:test.viewer")
    expect(extensionSelection(items, "extension:test.settings")).toBe("extension:test.settings")
  })

  test("preserves a deep-link selection while the initial list is empty", () => {
    expect(extensionSelection([], "extension:test.settings")).toBe("extension:test.settings")
    expect(extensionSelection([item("test.viewer"), item("test.settings", true)], "extension:test.settings")).toBe(
      "extension:test.settings",
    )
    expect(extensionSelection([], "plugin:test.viewer")).toBe("")
  })

  test("falls back for invalid or removed entries without using plugin ids", () => {
    expect(extensionSelection([item("test.viewer")], "extension:removed")).toBe("extension:test.viewer")
    expect(extensionSelection([item("test.viewer")], "plugin:test.viewer")).toBe("extension:test.viewer")
  })

  test("detects a same-length replacement in the extension id collection", () => {
    expect(extensionSelectionKey([item("first")])).not.toBe(extensionSelectionKey([item("second")]))
    expect(extensionSelectionKey([item("first")])).toBe(extensionSelectionKey([item("first", true)]))
  })

  test("keeps a visible catalog pick across host refreshes", () => {
    expect(extensionSelection([item("test.viewer")], "catalog:local.wls-repl", ["local.wls-repl"])).toBe(
      "catalog:local.wls-repl",
    )
    expect(extensionSelection([], "catalog:local.wls-repl")).toBe("catalog:local.wls-repl")
  })

  test("normalizes a stale catalog pick once the entry disappears from the visible catalog", () => {
    expect(extensionSelection([item("test.viewer")], "catalog:local.wls-repl", [])).toBe("extension:test.viewer")
  })

  test("migrates a catalog pick to the installed extension after install", () => {
    expect(extensionSelection([item("local.wls-repl")], "catalog:local.wls-repl", [])).toBe("extension:local.wls-repl")
    expect(extensionSelection([item("local.wls-repl")], "catalog:local.wls-repl", ["local.wls-repl"])).toBe(
      "extension:local.wls-repl",
    )
  })

  test("catalog namespace round-trips through its own parser", () => {
    expect(catalogPick("local.wls-repl")).toBe("catalog:local.wls-repl")
    expect(extensionSelection([], "catalog:local.wls-repl")).toBe("catalog:local.wls-repl")
  })
})
