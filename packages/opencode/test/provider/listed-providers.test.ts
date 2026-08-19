import { describe, expect, test } from "bun:test"
import { listedProviders, type Info } from "../../src/provider/provider"
import { ProviderID } from "../../src/provider/schema"

function provider(id: string): Info {
  return {
    id: ProviderID.make(id),
    name: id,
    source: "config",
    env: [],
    options: {},
    models: {},
  }
}

describe("listedProviders", () => {
  test("keeps disabled and unconnected known providers in all", () => {
    const commandcode = provider("commandcode")
    const openai = provider("openai")
    const anthropic = provider("anthropic")
    const result = listedProviders({
      known: { commandcode, openai, anthropic },
      connected: { anthropic },
    })

    expect(Object.keys(result).sort()).toEqual(["anthropic", "commandcode", "openai"])
    expect(result.commandcode).toBe(commandcode)
    expect(result.openai).toBe(openai)
    expect(result.anthropic).toBe(anthropic)
  })

  test("still honors enabled_providers", () => {
    const result = listedProviders({
      known: { commandcode: provider("commandcode"), openai: provider("openai") },
      connected: {},
      enabledProviders: ["commandcode"],
    })

    expect(Object.keys(result)).toEqual(["commandcode"])
  })
})
