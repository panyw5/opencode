import { describe, expect, test } from "bun:test"
import { agentFilePath, agentNameIssue, agentTemplate } from "./config-agent-create"

describe("agentFilePath", () => {
  test("joins root and trimmed title with .md extension", () => {
    expect(agentFilePath("/home/user/.config/opencode/agents", "reviewer")).toBe(
      "/home/user/.config/opencode/agents/reviewer.md",
    )
    expect(agentFilePath("C:\\proj\\.opencode\\agents", " helper ")).toBe("C:\\proj\\.opencode\\agents\\helper.md")
  })

  test("falls back to agent.md for an empty title", () => {
    expect(agentFilePath("/root/agents", "")).toBe("/root/agents/agent.md")
    expect(agentFilePath("/root/agents", "   ")).toBe("/root/agents/agent.md")
  })

  test("normalizes trailing separators on the root", () => {
    expect(agentFilePath("/root/agents/", "a")).toBe("/root/agents/a.md")
    expect(agentFilePath("C:\\root\\agents\\", "a")).toBe("C:\\root\\agents\\a.md")
  })
})

describe("agentNameIssue", () => {
  test("flags empty names", () => {
    expect(agentNameIssue("")).toBe("empty")
    expect(agentNameIssue("   ")).toBe("empty")
  })

  test("flags reserved dot names", () => {
    expect(agentNameIssue(".")).toBe("reserved")
    expect(agentNameIssue("..")).toBe("reserved")
  })

  test("flags path separators", () => {
    expect(agentNameIssue("a/b")).toBe("slash")
    expect(agentNameIssue("a\\b")).toBe("slash")
  })

  test("accepts regular names", () => {
    expect(agentNameIssue("reviewer")).toBeUndefined()
    expect(agentNameIssue(" my-agent_2 ")).toBeUndefined()
  })
})

describe("agentTemplate", () => {
  test("includes frontmatter with description and mode", () => {
    const text = agentTemplate("")
    expect(text).toContain("---")
    expect(text).toContain('description: "Describe what this agent does."')
    expect(text).toContain("mode: subagent")
  })

  test("uses the title as heading when provided", () => {
    expect(agentTemplate("reviewer")).toContain("# reviewer")
    expect(agentTemplate("")).toContain("# New Agent")
  })

  test("template stays stable so title edits can re-link with the body", () => {
    expect(agentTemplate("reviewer")).toBe(agentTemplate("reviewer"))
    expect(agentTemplate("reviewer")).not.toBe(agentTemplate("other"))
  })
})
