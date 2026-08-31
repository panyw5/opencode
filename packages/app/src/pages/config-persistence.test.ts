import { describe, expect, test } from "bun:test"
import type { Config } from "@opencode-ai/sdk/v2/client"
import { parse } from "jsonc-parser"
import {
  changedProviderEntry,
  declaredMcpEntries,
  declaredMcpEntry,
  declaredProviderEntry,
  formatArgv,
  globalProviderPatch,
  mcpDeclarationRecords,
  mcpSelectionID,
  parseArgv,
  parseMcpSelectionID,
  selectProjectMcpConfig,
  updateProjectMcpText,
} from "./config-persistence"

describe("config persistence", () => {
  test("MCP selection IDs preserve scope, directory, and name", () => {
    const selection = { scope: "project" as const, directory: "/tmp/project:one", name: "same:name" }
    const id = mcpSelectionID(selection)

    expect(parseMcpSelectionID(id)).toEqual(selection)
    expect(parseMcpSelectionID(mcpSelectionID({ scope: "global", directory: "", name: "same:name" }))).toEqual({
      scope: "global",
      directory: "",
      name: "same:name",
    })
  })

  test("MCP command argv formatting is reversible", () => {
    const argv = ["bun", "run", "two words", "", `quote'and\"double`, "back\\slash", "--flag=value"]

    expect(parseArgv(formatArgv(argv))).toEqual(argv)
    expect(parseArgv(`bun "two words" '' back\\\\slash`)).toEqual(["bun", "two words", "", "back\\slash"])
    expect(() => parseArgv(`bun 'unfinished`)).toThrow("unterminated quote")
  })

  test("MCP argv preserves Windows paths and newline arguments", () => {
    expect(parseArgv(String.raw`tool "C:\Program Files\tool.exe" "a\qb"`)).toEqual([
      "tool",
      String.raw`C:\Program Files\tool.exe`,
      String.raw`a\qb`,
    ])

    const argv = ["tool", "line one\nline two", "carriage\rreturn"]
    expect(formatArgv(argv).startsWith("[")).toBe(true)
    expect(parseArgv(formatArgv(argv))).toEqual(argv)
  })

  test("provider updates never include unrelated effective config", () => {
    const effective = {
      agent: { "markdown-agent": { prompt: "derived" } },
      command: { "markdown-command": { template: "derived" } },
      plugin: ["./project-plugin.ts"],
    } satisfies Config
    const provider = { custom: { name: "Custom", options: { apiKey: "secret" } } } as NonNullable<Config["provider"]>

    const patch = globalProviderPatch(provider, ["disabled"])

    expect(patch).toEqual({ provider, disabled_providers: ["disabled"] })
    expect(patch).not.toHaveProperty("agent")
    expect(patch).not.toHaveProperty("command")
    expect(patch).not.toHaveProperty("plugin")
    expect(effective.agent).toBeDefined()
  })

  test("provider updates contain only changed provider entries", () => {
    const changed = {
      renamed: { name: "Renamed" },
      old: {},
    } as NonNullable<Config["provider"]>

    const patch = globalProviderPatch(changed, [])

    expect(Object.keys(patch.provider ?? {}).sort()).toEqual(["old", "renamed"])
    expect(patch.provider).not.toHaveProperty("unrelated")
  })

  test("provider edits do not materialize unchanged effective secrets", () => {
    const effective = {
      name: "Provider",
      options: {
        apiKey: "resolved-secret",
        baseURL: "https://resolved.test",
        headers: { Authorization: "resolved-header" },
      },
    }
    const next = {
      ...effective,
      name: "Renamed Provider",
    }

    expect(changedProviderEntry(effective, next, false)).toEqual({ name: "Renamed Provider" })
    expect(changedProviderEntry(effective, next, true)).toEqual({
      name: "Renamed Provider",
      options: { apiKey: "resolved-secret" },
    })
  })

  test("provider header edits preserve unchanged raw placeholders", () => {
    const declared = {
      options: {
        headers: { Authorization: "{env:TOKEN}", "X-Mode": "old" },
      },
    }
    const effective = {
      options: {
        headers: { Authorization: "resolved-secret", "X-Mode": "old" },
      },
    }
    const next = {
      options: {
        headers: { Authorization: "resolved-secret", "X-Mode": "new" },
      },
    }

    expect(changedProviderEntry(effective, next, false, declared)).toEqual({
      options: { headers: { Authorization: "{env:TOKEN}", "X-Mode": "new" } },
    })
  })

  test("provider edits can clear env, headers, and models", () => {
    const effective = {
      env: ["API_KEY"],
      models: { old: { name: "Old" } },
      options: { headers: { Authorization: "secret" } },
    }
    const next = { options: {} }

    expect(changedProviderEntry(effective, next, false, effective)).toEqual({
      env: [],
      models: {},
      options: { headers: {} },
    })
  })

  test("provider edits treat absent and empty headers as unchanged", () => {
    expect(changedProviderEntry({ options: {} }, { options: { headers: {} } }, false, { options: {} })).toBeUndefined()
  })

  test("provider model edits preserve nested raw placeholders", () => {
    const declared = {
      models: {
        model: {
          name: "Old",
          headers: { Authorization: "{env:MODEL_TOKEN}" },
        },
      },
    }
    const effective = {
      models: {
        model: {
          name: "Old",
          headers: { Authorization: "resolved-secret" },
        },
      },
    }
    const next = {
      models: {
        model: {
          name: "New",
          headers: { Authorization: "resolved-secret" },
        },
      },
    }

    expect(changedProviderEntry(effective, next, false, declared)).toEqual({
      models: {
        model: {
          name: "New",
          headers: { Authorization: "{env:MODEL_TOKEN}" },
        },
      },
    })
  })

  test("finds provider declaration from raw config records", () => {
    expect(
      declaredProviderEntry(
        [
          { file: { label: "opencode.jsonc", path: "/config/opencode.jsonc" }, text: `{"provider":{"target":{"name":"Raw"}}}` },
          { file: { label: "opencode.json", path: "/config/opencode.json" }, text: "{}" },
        ],
        "target",
      ),
    ).toEqual({ name: "Raw" })
  })

  test("merges raw declarations in config precedence order", () => {
    const records = [
      {
        file: { label: "opencode.jsonc", path: "/config/opencode.jsonc" },
        text: `{"provider":{"target":{"options":{"baseURL":"https://high.test"}}},"mcp":{"target":{"headers":{"X-High":"yes"}}}}`,
      },
      {
        file: { label: "config.json", path: "/config/config.json" },
        text: `{"provider":{"target":{"options":{"apiKey":"{env:TOKEN}"}}},"mcp":{"target":{"type":"remote","url":"{env:MCP_URL}"}}}`,
      },
    ]

    expect(declaredProviderEntry(records, "target")).toEqual({
      options: { apiKey: "{env:TOKEN}", baseURL: "https://high.test" },
    })
    expect(declaredMcpEntry(records, "target")).toEqual({
      type: "remote",
      url: "{env:MCP_URL}",
      headers: { "X-High": "yes" },
    })
    expect(declaredMcpEntries(records)).toEqual({
      target: { type: "remote", url: "{env:MCP_URL}", headers: { "X-High": "yes" } },
    })
    expect(mcpDeclarationRecords(records, "target").map((item) => item.file.label)).toEqual([
      "opencode.jsonc",
      "config.json",
    ])
  })

  test("project MCP edits preserve raw placeholders and unrelated JSONC", () => {
    const input = `{
      // Keep this comment.
      "provider": { "custom": { "options": { "apiKey": "{env:API_KEY}" } } },
      "agent": { "local": { "prompt": "keep" } },
      "mcp": { "old": { "type": "remote", "url": "https://old.test" } }
    }`

    const updated = updateProjectMcpText(input, "next", { type: "remote", url: "https://next.test" })

    expect(updated).toContain("// Keep this comment.")
    expect(updated).toContain("{env:API_KEY}")
    expect(parse(updated)).toMatchObject({
      agent: { local: { prompt: "keep" } },
      mcp: {
        old: { type: "remote", url: "https://old.test" },
        next: { type: "remote", url: "https://next.test" },
      },
    })
  })

  test("project MCP deletion removes only the declared entry", () => {
    const updated = updateProjectMcpText(
      `{"mcp":{"keep":{"type":"remote","url":"https://keep.test"},"drop":{"type":"remote","url":"https://drop.test"}}}`,
      "drop",
      undefined,
    )

    expect(parse(updated)).toEqual({ mcp: { keep: { type: "remote", url: "https://keep.test" } } })
  })

  test("project MCP edits preserve placeholders on unchanged target fields", () => {
    const input = `{
      "mcp": {
        "target": {
          "type": "remote",
          "url": "{env:MCP_URL}",
          "headers": { "Authorization": "{file:token.txt}", "X-Mode": "old" },
          "enabled": false
        }
      }
    }`
    const effective = {
      type: "remote" as const,
      url: "https://resolved.test",
      headers: { Authorization: "resolved-secret", "X-Mode": "old" },
      enabled: false,
    }
    const next = { ...effective, headers: { Authorization: "resolved-secret", "X-Mode": "new" } }

    const updated = updateProjectMcpText(input, "target", next, effective)

    expect(updated).toContain("{env:MCP_URL}")
    expect(updated).not.toContain("https://resolved.test")
    expect(updated).toContain('"Authorization": "{file:token.txt}"')
    expect(updated).toContain('"X-Mode": "new"')
    expect(updated).toContain('"enabled": false')
  })

  test("project MCP targets its declaration and defaults new entries to .opencode JSONC", () => {
    const records = [
      { file: { label: "opencode.jsonc", path: "/project/opencode.jsonc" }, text: `{"mcp":{"existing":{}}}` },
      { file: { label: ".opencode/opencode.jsonc", path: "/project/.opencode/opencode.jsonc" }, text: "{}" },
    ]

    expect(selectProjectMcpConfig(records, "existing", false)?.file.path).toBe("/project/opencode.jsonc")
    expect(selectProjectMcpConfig(records, "new", true)?.file.path).toBe("/project/.opencode/opencode.jsonc")
    expect(selectProjectMcpConfig(records, "missing", false)).toBeUndefined()
  })

  test("project MCP edits the highest-precedence declaration", () => {
    const records = [
      { file: { label: "opencode.jsonc", path: "/project/opencode.jsonc" }, text: `{"mcp":{"target":{"type":"remote","url":"https://root.test"}}}` },
      { file: { label: ".opencode/opencode.jsonc", path: "/project/.opencode/opencode.jsonc" }, text: `{"mcp":{"target":{"type":"remote","url":"https://dot.test"}}}` },
    ]

    expect(selectProjectMcpConfig(records, "target", false)?.file.path).toBe("/project/.opencode/opencode.jsonc")
  })
})
