import { describe, expect, test } from "bun:test"
import type { Agent, Config } from "@opencode-ai/sdk/v2/client"
import { configAgentDisplayItems, configuredAgentsFromJsonc, jsoncAgentVariantOptions } from "./config-agent-display"

function agent(name: string, input: Partial<Agent> = {}): Agent {
  return {
    name,
    mode: "all",
    permission: [],
    options: {},
    ...input,
  }
}

describe("config agent display items", () => {
  test("uses model variants while preserving an existing unlisted JSONC variant", () => {
    expect(jsoncAgentVariantOptions({ low: {}, high: {} }, "high")).toEqual(["", "low", "high"])
    expect(jsoncAgentVariantOptions({ low: {} }, "legacy")).toEqual(["", "low", "legacy"])
    expect(jsoncAgentVariantOptions(undefined, "")).toEqual([""])
  })

  test("reads agent overrides from JSONC", () => {
    const result = configuredAgentsFromJsonc(`{
      // Keep the config file as the source of truth for display-only agents.
      "agent": {
        "trellis-check": { "model": "axonhub-codex/gpt-5.5" },
      },
    }`)

    expect(result).toEqual({ "trellis-check": { model: "axonhub-codex/gpt-5.5" } })
  })

  test("includes built-in and configured agents without definitions", () => {
    const result = configAgentDisplayItems({
      runtime: [
        agent("build", { native: true, mode: "primary" }),
        agent("plan", { native: true, mode: "primary" }),
        agent("trellis-check", { mode: "subagent" }),
      ],
      configured: {
        "trellis-check": { model: "axonhub-codex/gpt-5.5" },
        "trellis-research": { model: "axonhub-codex/gpt-5.5", mode: "subagent" },
      } as Config["agent"],
      definedNames: [],
    })

    expect(result.map((item) => [item.name, item.origin])).toEqual([
      ["build", "built-in"],
      ["plan", "built-in"],
      ["trellis-check", "config"],
      ["trellis-research", "config"],
    ])
  })

  test("keeps hidden internal agents out unless explicitly configured", () => {
    const result = configAgentDisplayItems({
      runtime: [agent("title", { native: true, hidden: true }), agent("summary", { native: true, hidden: true })],
      configured: { title: { model: "provider/model" } } as Config["agent"],
      definedNames: [],
    })

    expect(result.map((item) => item.name)).toEqual(["title"])
  })

  test("keeps explicit config entries visible alongside their definitions", () => {
    const result = configAgentDisplayItems({
      runtime: [agent("explore", { native: true }), agent("plugin-agent"), agent("trellis-check")],
      configured: { "config-only": { disable: true }, "trellis-check": { model: "provider/model" } } as Config["agent"],
      definedNames: ["plugin-agent"],
    })

    expect(result.map((item) => item.name)).toEqual(["explore", "trellis-check", "config-only"])
  })

  test("does not create JSONC entries from merged Markdown agent configuration", () => {
    const result = configAgentDisplayItems({
      runtime: [agent("literature"), agent("wls-computational-verifier")],
      // These names are defined by .config/opencode/agents/*.md and must not
      // become editable JSONC cards merely because the server merges metadata.
      configured: undefined,
      definedNames: ["literature", "wls-computational-verifier"],
    })

    expect(result).toEqual([])
  })

  test("classifies native, config, and runtime-only entries by source", () => {
    const result = configAgentDisplayItems({
      runtime: [agent("build", { native: true }), agent("plugin-agent")],
      configured: { "config-agent": { model: "provider/model" } } as Config["agent"],
      definedNames: [],
    })

    expect(result.map((item) => [item.name, item.origin])).toEqual([
      ["build", "built-in"],
      ["plugin-agent", "runtime"],
      ["config-agent", "config"],
    ])
  })
})
