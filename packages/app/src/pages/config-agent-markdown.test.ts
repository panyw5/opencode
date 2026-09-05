import { describe, expect, test } from "bun:test"
import {
  parseAgentMarkdown,
  upsertAgentMarkdownModel,
} from "./config-agent-markdown"

const coder = `---
mode: subagent
permission:
  bash: allow
  glob: allow
  grep: allow
  list: allow
  read: allow
  webfetch: allow
  websearch: allow
  external_directory: deny
temperature: 0.1
model: axonhub/glm-5.3-flash
description: Code implementation expert.
---
You are a skilled code implementation expert.
`

describe("parseAgentMarkdown", () => {
  test("parses nested permission maps and model from agent markdown", () => {
    const parsed = parseAgentMarkdown(coder)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.model).toBe("axonhub/glm-5.3-flash")
    expect(parsed.mode).toBe("subagent")
    expect(parsed.permissions.map((item) => [item.permission, item.action, item.known, item.validAction])).toEqual([
      ["bash", "allow", true, true],
      ["glob", "allow", true, true],
      ["grep", "allow", true, true],
      ["list", "allow", true, true],
      ["read", "allow", true, true],
      ["webfetch", "allow", true, true],
      ["websearch", "allow", true, true],
      ["external_directory", "deny", true, true],
    ])
  })

  test("parses per-pattern permission objects and inline maps", () => {
    const parsed = parseAgentMarkdown(`---
model: anthropic/claude-sonnet-4-6
permission:
  edit: deny
  bash:
    "git *": allow
    "*": ask
  read: { "*": allow, "*.env": ask }
---
prompt
`)
    expect(parsed.model).toBe("anthropic/claude-sonnet-4-6")
    expect(
      parsed.permissions.map((item) => [item.permission, item.pattern ?? "*", item.action]),
    ).toEqual([
      ["edit", "*", "deny"],
      ["bash", "git *", "allow"],
      ["bash", "*", "ask"],
      ["read", "*", "allow"],
      ["read", "*.env", "ask"],
    ])
  })

  test("parses permission shorthand and flags unknown keys or invalid actions", () => {
    const parsed = parseAgentMarkdown(`---
permission: allow
---
`)
    expect(parsed.permissions).toEqual([
      {
        id: "*:*:allow",
        permission: "*",
        pattern: undefined,
        action: "allow",
        known: true,
        validAction: true,
      },
    ])

    const messy = parseAgentMarkdown(`---
permission:
  web-fetch: allow
  bash: allowed
  codesearch: allow
---
`)
    expect(messy.permissions.map((item) => [item.permission, item.action, item.known, item.validAction])).toEqual([
      ["web-fetch", "allow", false, true],
      ["bash", "allowed", true, false],
      ["codesearch", "allow", true, true],
    ])
  })

  test("promotes deprecated tools map into permission capsules", () => {
    const parsed = parseAgentMarkdown(`---
tools:
  bash: true
  write: false
permission:
  grep: allow
---
`)
    expect(parsed.permissions.map((item) => [item.permission, item.action])).toEqual([
      ["bash", "allow"],
      ["edit", "deny"],
      ["grep", "allow"],
    ])
  })

  test("returns empty meta when frontmatter is missing", () => {
    expect(parseAgentMarkdown("# just a prompt\n")).toEqual({
      hasFrontmatter: false,
      permissions: [],
    })
  })
})

describe("upsertAgentMarkdownModel", () => {
  test("replaces an existing top-level model without touching permissions or body", () => {
    const next = upsertAgentMarkdownModel(coder, "axonhub-codex/gpt-5.6-luna")
    const parsed = parseAgentMarkdown(next)
    expect(parsed.model).toBe("axonhub-codex/gpt-5.6-luna")
    expect(parsed.permissions.map((item) => item.permission)).toEqual([
      "bash",
      "glob",
      "grep",
      "list",
      "read",
      "webfetch",
      "websearch",
      "external_directory",
    ])
    expect(next.endsWith("You are a skilled code implementation expert.\n")).toBe(true)
    expect(next).toContain("permission:\n  bash: allow")
  })

  test("inserts model into existing frontmatter", () => {
    const next = upsertAgentMarkdownModel(
      `---
mode: subagent
permission:
  bash: allow
---
body
`,
      "provider/model",
    )
    expect(next.startsWith("---\nmodel: provider/model\nmode: subagent\n")).toBe(true)
    expect(parseAgentMarkdown(next).model).toBe("provider/model")
    expect(next).toContain("body\n")
  })

  test("creates frontmatter when the file has none", () => {
    const next = upsertAgentMarkdownModel("Just a prompt.\n", "provider/model")
    expect(next).toBe(`---
model: provider/model
---

Just a prompt.
`)
    expect(parseAgentMarkdown(next).model).toBe("provider/model")
  })

  test("clears model and leaves the rest of the frontmatter", () => {
    const next = upsertAgentMarkdownModel(coder, "")
    const parsed = parseAgentMarkdown(next)
    expect(parsed.model).toBeUndefined()
    expect(parsed.permissions.some((item) => item.permission === "bash")).toBe(true)
    expect(next).not.toMatch(/^model:/m)
    expect(next).toContain("mode: subagent")
  })

  test("does not rewrite nested keys named model", () => {
    const input = `---
options:
  model: keep-me
model: old/model
---
body
`
    const next = upsertAgentMarkdownModel(input, "new/model")
    expect(next).toContain("  model: keep-me")
    expect(parseAgentMarkdown(next).model).toBe("new/model")
  })
})
