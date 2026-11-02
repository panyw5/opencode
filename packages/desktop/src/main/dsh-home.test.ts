import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { updateDshCredential } from "@opencode-ai/util/dsh-credentials"
const parse = (text: string) => Bun.YAML.parse(text) as Record<string, any>
import {
  parseAgentDefaultModel,
  parseCredentialsYaml,
  parseYamlSection,
  removeYamlSection,
  serializeCredentialsYaml,
  upsertAgentDefaultModel,
  upsertYamlSection,
  writeDshApiKey,
  clearDshApiKey,
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
    expect(text).toContain('A: "1"')
    expect(text).toContain('B: "2"')
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

describe("DSH credential document updates", () => {
  const source = [
    "# Keep this account",
    "version: 1",
    "refs:",
    "  DEEPSEEK_API_KEY: old-key",
    "  OTHER_KEY: other-key # keep annotation",
    "records:",
    "  llm-pi-ai/openai-codex:",
    "    kind: grant",
    "    payload:",
    "      type: oauth",
    "      access: fake-access",
    "      refresh: fake-refresh",
    "      expires: 1234567890",
    "foreign: { keep: true }",
    "",
  ].join("\n")

  test("save and clear preserve records, unknown fields and comments", () => {
    const saved = updateDshCredential(source, "DEEPSEEK_API_KEY", "new-key")
    expect(parse(saved)).toEqual({ ...parse(source), refs: { ...parse(source).refs, DEEPSEEK_API_KEY: "new-key" } })
    expect(saved).toContain("# Keep this account")
    expect(saved).toContain("# keep annotation")
    const cleared = updateDshCredential(saved, "DEEPSEEK_API_KEY", undefined)
    expect(parse(cleared).records).toEqual(parse(source).records)
    expect(parse(cleared).refs).toEqual({ OTHER_KEY: "other-key" })
    expect(parse(cleared).foreign).toEqual({ keep: true })
    expect(parseCredentialsYaml(saved)).toEqual(
      new Map([
        ["DEEPSEEK_API_KEY", "new-key"],
        ["OTHER_KEY", "other-key"],
      ]),
    )
  })

  test("legacy documents remain legacy and multiline keys round-trip", () => {
    const value = "line one\nline two: # 'quoted'"
    const next = updateDshCredential("OTHER: keep\n", "DEEPSEEK_API_KEY", value)
    expect(parse(next).version).toBeUndefined()
    expect(parseCredentialsYaml(next).get("DEEPSEEK_API_KEY")).toBe(value)
    expect(parseCredentialsYaml(next).get("OTHER")).toBe("keep")
  })

  test("invalid, duplicate and future documents fail without exposing secrets", () => {
    for (const text of [
      "KEY: [secret-value",
      "KEY: one\nKEY: two\n",
      "version: 2\nrefs: {}\n",
      "refs: { KEY: value }\n",
      "- secret-value\n",
    ]) {
      expect(() => updateDshCredential(text, "DEEPSEEK_API_KEY", "new")).toThrow()
      try {
        updateDshCredential(text, "DEEPSEEK_API_KEY", "new")
      } catch (error) {
        expect(String(error)).not.toContain("secret-value")
      }
    }
  })

  test("file writes are private, serialized and leave invalid documents untouched", async () => {
    const home = await mkdtemp(join(tmpdir(), "opencode-dsh-credentials-"))
    const file = join(home, ".credentials.yaml")
    try {
      await writeFile(file, source)
      await Promise.all([writeDshApiKey(home, "first"), writeDshApiKey(home, "second")])
      expect(parse(await readFile(file, "utf8")).records).toEqual(parse(source).records)
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
      await clearDshApiKey(home)
      expect(parse(await readFile(file, "utf8")).refs).toEqual({ OTHER_KEY: "other-key" })
      await writeFile(file, "KEY: [private-invalid")
      await expect(writeDshApiKey(home, "replacement")).rejects.toThrow("Invalid DSH")
      expect(await readFile(file, "utf8")).toBe("KEY: [private-invalid")
      expect(await stat(file + ".lock").catch(() => undefined)).toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
