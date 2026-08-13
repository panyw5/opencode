import { describe, expect, test } from "bun:test"
import {
  parseAgentDefaultModel,
  parseCredentialsYaml,
  parseYamlSection,
  removeYamlSection,
  serializeCredentialsYaml,
  upsertAgentDefaultModel,
  upsertYamlSection,
} from "./dsh-home"

describe("dsh-home yaml helpers", () => {
  test("parseCredentialsYaml reads simple mapping", () => {
    const map = parseCredentialsYaml("DEEPSEEK_API_KEY: sk-test\nOTHER: value\n")
    expect(map.get("DEEPSEEK_API_KEY")).toBe("sk-test")
    expect(map.get("OTHER")).toBe("value")
  })

  test("serializeCredentialsYaml is stable", () => {
    const map = new Map([
      ["B", "2"],
      ["A", "1"],
    ])
    const text = serializeCredentialsYaml(map)
    expect(text).toContain("A: 1")
    expect(text).toContain("B: 2")
    expect(parseCredentialsYaml(text).get("A")).toBe("1")
  })

  test("parseAgentDefaultModel reads nested section", () => {
    const text = `
other:
  x: 1
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-pro
llm-pi-ai:
  foo: bar
`
    expect(parseAgentDefaultModel(text)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-pro",
    })
  })

  test("upsertAgentDefaultModel inserts when missing", () => {
    const next = upsertAgentDefaultModel("", { provider: "p", model: "m" })
    expect(next).toContain("agent-default-model:")
    expect(parseAgentDefaultModel(next)).toEqual({ provider: "p", model: "m" })
  })

  test("upsertAgentDefaultModel replaces existing section", () => {
    const prev = `keep:\n  a: 1\nagent-default-model:\n  provider: old\n  model: old-m\ntrail:\n  z: 9\n`
    const next = upsertAgentDefaultModel(prev, { provider: "new", model: "new-m" })
    expect(next).toContain("keep:")
    expect(next).toContain("trail:")
    expect(parseAgentDefaultModel(next)).toEqual({ provider: "new", model: "new-m" })
    expect(next).not.toContain("old-m")
  })

  test("upsertYamlSection writes llm-deepseek baseURL", () => {
    const next = upsertYamlSection("", "llm-deepseek", {
      baseURL: "https://gateway.example/v1",
    })
    expect(parseYamlSection(next, "llm-deepseek")).toEqual({
      baseURL: "https://gateway.example/v1",
    })
  })

  test("removeYamlSection clears llm-deepseek while keeping agent-default-model", () => {
    const prev = [
      "agent-default-model:",
      "  provider: deepseek-official",
      "  model: deepseek-v4-flash",
      "llm-deepseek:",
      "  baseURL: https://gateway.example",
      "trail:",
      "  z: 1",
      "",
    ].join("\n")
    const next = removeYamlSection(prev, "llm-deepseek")
    expect(parseYamlSection(next, "llm-deepseek")).toEqual({})
    expect(parseAgentDefaultModel(next)).toEqual({
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    })
    expect(next).toContain("trail:")
  })
})
