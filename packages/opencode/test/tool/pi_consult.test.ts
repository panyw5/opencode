import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { buildPiArgs, Parameters } from "../../src/tool/pi_consult"
import { Config } from "../../src/config/config"

describe("Pi consult configuration", () => {
  test("selects only read tools, disables executable resources, and keeps model as one argv token", () => {
    const model = "fixture/model with spaces"
    const args = buildPiArgs(model)
    expect(args.slice(-2)).toEqual(["--model", model])
    expect(args).toContain("read,grep,find,ls")
    for (const flag of [
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-approve",
      "--no-skills",
      "--no-prompt-templates",
    ])
      expect(args).toContain(flag)
    expect(buildPiArgs()).not.toContain("--model")
  })

  test("validates the tool parameters", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    expect(decode({ prompt: "Review this" })).toEqual({ prompt: "Review this" })
    expect(() => decode({})).toThrow()
    expect(() => decode({ prompt: "Review", timeout_ms: "1000" })).toThrow()
    expect(() => decode({ prompt: "Review", model: 123 })).toThrow()
  })

  test("persists Pi executable, config home, enable state and tool permission through backend config", () => {
    const input = {
      pi: { enabled: true, binaryPath: "/custom/pi", configHome: "/custom/pi-home" },
      permission: { pi_consult: "ask" },
    }
    expect(Schema.decodeUnknownSync(Config.Info)(input)).toMatchObject(input)
    expect(() => Schema.decodeUnknownSync(Config.Info)({ pi: { enabled: "yes" } })).toThrow()
  })
})
