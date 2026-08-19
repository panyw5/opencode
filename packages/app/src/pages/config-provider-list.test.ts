import { describe, expect, test } from "bun:test"
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import {
  canSignOutProvider,
  collectConfigProviders,
  nextDisabledProviders,
  providerEnabled,
} from "./config-provider-list"

type ListedProvider = ProviderListResponse["all"][number]

function listed(input: {
  id: string
  name?: string
  source?: ListedProvider["source"]
  npm?: string
  models?: string[]
}): ListedProvider {
  return {
    id: input.id,
    name: input.name ?? input.id,
    source: input.source ?? "custom",
    env: [],
    options: {},
    models: Object.fromEntries(
      (input.models ?? ["chat"]).map((id) => [
        id,
        {
          id,
          providerID: input.id,
          api: { id, url: "", npm: input.npm ?? "" },
          name: id,
          capabilities: {
            temperature: false,
            reasoning: false,
            attachment: false,
            toolcall: false,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false },
            interleaved: false,
          },
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          limit: { context: 0, output: 0 },
          status: "active",
          options: {},
          headers: {},
          release_date: "",
        },
      ]),
    ),
  } as ListedProvider
}

describe("config provider list", () => {
  test("keeps disabled and unconnected built-in providers in the existing group", () => {
    const items = collectConfigProviders({
      all: [
        listed({ id: "commandcode", name: "Command Code", source: "config", models: ["gpt-5.5"] }),
        listed({ id: "anthropic", name: "Anthropic", source: "api", models: ["claude"] }),
        listed({ id: "openai", name: "OpenAI", source: "custom", models: ["gpt"] }),
      ],
      connected: ["anthropic"],
      disabled: ["commandcode"],
      configProviders: {},
    })

    const commandcode = items.find((item) => item.id === "commandcode")
    const anthropic = items.find((item) => item.id === "anthropic")
    const openai = items.find((item) => item.id === "openai")

    expect(commandcode).toMatchObject({ connected: false, allowed: false, custom: false })
    expect(anthropic).toMatchObject({ connected: true, allowed: true })
    expect(openai).toMatchObject({ connected: false, allowed: true })
    expect(providerEnabled(commandcode)).toBe(false)
    expect(providerEnabled(anthropic)).toBe(true)
    expect(providerEnabled(openai)).toBe(false)
    expect(canSignOutProvider(commandcode)).toBe(true)
    expect(canSignOutProvider(anthropic)).toBe(true)
    expect(canSignOutProvider(openai)).toBe(false)
  })

  test("synthesizes a disabled built-in from config when the runtime list dropped it", () => {
    const items = collectConfigProviders({
      all: [],
      connected: [],
      disabled: ["commandcode"],
      configProviders: {
        commandcode: {
          name: "Command Code",
          npm: "commandcode",
          models: { "gpt-5.5": { name: "GPT-5.5" } },
        },
      },
    })

    const commandcode = items.find((item) => item.id === "commandcode")
    expect(commandcode).toMatchObject({
      id: "commandcode",
      name: "Command Code",
      connected: false,
      allowed: false,
      custom: false,
      source: "config",
      models: ["gpt-5.5"],
    })
    expect(providerEnabled(commandcode)).toBe(false)
    expect(canSignOutProvider(commandcode)).toBe(true)
  })

  test("uses config models when the runtime commandcode entry has none", () => {
    const items = collectConfigProviders({
      all: [listed({ id: "commandcode", name: "Command Code", source: "config", models: [] })],
      connected: ["commandcode"],
      disabled: [],
      configProviders: {
        commandcode: {
          name: "Command Code",
          npm: "commandcode",
          models: { "gpt-5.5": { name: "GPT-5.5" }, "xiaomi/mimo-v2.5-pro": { name: "MiMo V2.5 Pro" } },
        },
      },
    })
    expect(items.find((item) => item.id === "commandcode")?.models).toEqual(["gpt-5.5", "xiaomi/mimo-v2.5-pro"])
  })

  test("keeps built-in commandcode visible when the runtime catalog omitted it", () => {
    const items = collectConfigProviders({
      all: [],
      connected: [],
      disabled: [],
      configProviders: {},
    })
    expect(items.find((item) => item.id === "commandcode")).toMatchObject({
      name: "Command Code",
      connected: false,
      allowed: true,
      custom: false,
    })
  })

  test("disable and sign-out keep separate disabled_providers effects", () => {
    expect(nextDisabledProviders(["openai"], "commandcode", false)).toEqual(["openai", "commandcode"])
    expect(nextDisabledProviders(["openai", "commandcode"], "commandcode", true)).toEqual(["openai"])
  })
})
