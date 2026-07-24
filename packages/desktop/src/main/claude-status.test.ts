import { describe, expect, test } from "bun:test"
import { parseClaudeSettingsJson } from "./claude-status"

describe("claude-status settings helpers", () => {
  test("parseClaudeSettingsJson extracts common Claude settings", () => {
    const result = parseClaudeSettingsJson(
      JSON.stringify({
        model: "sonnet",
        permissionMode: "dontAsk",
        defaultMode: "plan",
        apiKeyHelper: "security find-generic-password",
      }),
    )

    expect(result).toEqual([
      { label: "Model", value: "sonnet" },
      { label: "Permission mode", value: "dontAsk" },
      { label: "Default mode", value: "plan" },
      { label: "API key helper", value: "security find-generic-password" },
    ])
  })

  test("parseClaudeSettingsJson ignores invalid JSON", () => {
    expect(parseClaudeSettingsJson("{nope")).toEqual([])
  })
})
