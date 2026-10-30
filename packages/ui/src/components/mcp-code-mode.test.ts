import { expect, test } from "bun:test"
import { codeModeTitle, readMcpCodeModeCalls } from "./mcp-code-mode"

test("Code Mode titles distinguish general query executions from legacy MCP history", () => {
  expect(codeModeTitle({ codemodeScope: "query" })).toBe("Code Mode")
  expect(codeModeTitle({})).toBe("MCP Code Mode")
})

test("Code Mode call metadata tolerates malformed and legacy values", () => {
  expect(readMcpCodeModeCalls({})).toEqual([])
  expect(
    readMcpCodeModeCalls({ toolCalls: [null, "bad", {}, { tool: "s_t", status: "completed", input: "{}" }] }),
  ).toEqual([{ tool: "s_t", status: "completed", input: "{}", error: undefined }])
})

test("Code Mode call rendering has bounded rows and text", () => {
  const calls = readMcpCodeModeCalls({
    toolCalls: Array.from({ length: 1000 }, () => ({
      tool: "x".repeat(1000),
      status: "error",
      input: "x".repeat(10000),
      error: "x".repeat(10000),
    })),
  })
  expect(calls).toHaveLength(64)
  expect(calls[0].tool).toHaveLength(200)
  expect(calls[0].input).toHaveLength(2048)
  expect(calls[0].error).toHaveLength(2048)
})
