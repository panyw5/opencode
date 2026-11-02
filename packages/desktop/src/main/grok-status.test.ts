import { describe, expect, test } from "bun:test"
import { defaultGrokHome, parseGrokConfigToml, resolveGrokHome } from "./grok-status"
import { resolve } from "node:path"

describe("grok-status config helpers", () => {
  test("reads the configured model from config.toml", () => {
    expect(parseGrokConfigToml('[ui]\nfork_secondary_model = "grok-build"')).toEqual([
      { label: "Model", value: "grok-build" },
    ])
  })

  test("falls back to a root model setting", () => {
    expect(parseGrokConfigToml('model = "grok-4"')).toEqual([{ label: "Model", value: "grok-4" }])
  })

  test("ignores invalid or absent model entries", () => {
    expect(parseGrokConfigToml("model = 42")).toEqual([])
  })

  test("prefers the current models.default setting over legacy UI settings", () => {
    expect(parseGrokConfigToml('[ui]\nfork_secondary_model = "old"\n[models]\ndefault = "grok-build"\n')).toEqual([
      { label: "Model", value: "grok-build" },
    ])
    expect(parseGrokConfigToml('[models]\ndefault = "grok-build"\n[ui]\nfork_secondary_model = "old"\n')).toEqual([
      { label: "Model", value: "grok-build" },
    ])
  })

  test("honors GROK_HOME with an explicit settings override taking precedence", () => {
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = "/tmp/grok-from-env"
    try {
      expect(defaultGrokHome()).toBe(resolve("/tmp/grok-from-env"))
      expect(resolveGrokHome()).toBe(resolve("/tmp/grok-from-env"))
      expect(resolveGrokHome({ enabled: true, configHome: "/tmp/grok-settings" })).toBe(resolve("/tmp/grok-settings"))
    } finally {
      if (previous === undefined) delete process.env.GROK_HOME
      else process.env.GROK_HOME = previous
    }
  })
})
