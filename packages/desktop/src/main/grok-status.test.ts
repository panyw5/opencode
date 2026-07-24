import { describe, expect, test } from "bun:test"
import { parseGrokConfigToml } from "./grok-status"

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
})
