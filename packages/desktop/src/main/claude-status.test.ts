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

    expect(result).toEqual({
      model: "sonnet",
      permissionMode: "dontAsk",
      defaultMode: "plan",
      apiKeyHelper: "security find-generic-password",
    })
  })

  test("parseClaudeSettingsJson ignores invalid JSON", () => {
    expect(parseClaudeSettingsJson("{nope")).toEqual({})
  })
})
