import { describe, expect, test } from "bun:test"
import { parseCodexConfigToml, readTomlSection, readTomlString } from "./codex-status"

const sample = `
model_provider = "custom"
model = "gpt-5.5"
model_reasoning_effort = "high"
disable_response_storage = true
model_context_window = 1000000
model_auto_compact_token_limit = 850000

[model_providers]
[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = true
base_url = "https://api.example.com/v1"

[projects."/Users/me/apps/opencode"]
trust_level = "trusted"

[projects."/Users/me/apps/Root"]
trust_level = "trusted"
`

describe("codex-status toml helpers", () => {
  test("reads top-level string keys", () => {
    expect(readTomlString(sample, "model")).toBe("gpt-5.5")
    expect(readTomlString(sample, "model_provider")).toBe("custom")
    expect(readTomlString(sample, "model_reasoning_effort")).toBe("high")
    expect(readTomlString(sample, "model_context_window")).toBe("1000000")
  })

  test("extracts nested provider section", () => {
    const section = readTomlSection(sample, "model_providers.custom")
    expect(readTomlString(section, "base_url")).toBe("https://api.example.com/v1")
    expect(readTomlString(section, "wire_api")).toBe("responses")
  })

  test("parseCodexConfigToml aggregates model and provider fields", () => {
    const parsed = parseCodexConfigToml(sample)
    expect(parsed).toContainEqual({ label: "Model", value: "gpt-5.5" })
    expect(parsed).toContainEqual({ label: "Model provider", value: "custom" })
    expect(parsed).toContainEqual({ label: "Reasoning effort", value: "high" })
    expect(parsed).toContainEqual({ label: "Context window", value: "1000000" })
    expect(parsed).toContainEqual({ label: "Auto-compact limit", value: "850000" })
    expect(parsed).toContainEqual({ label: "Provider base URL", value: "https://api.example.com/v1" })
    expect(parsed).toContainEqual({ label: "Wire API", value: "responses" })
    expect(parsed).toContainEqual({ label: "Trusted projects", value: "2" })
  })
})
