export type McpCodeModeCall = {
  tool: string
  status: "running" | "completed" | "error"
  input?: string
  error?: string
}

export function codeModeTitle(metadata: Record<string, unknown>) {
  return metadata.codemodeScope === "query" ? "Code Mode" : "MCP Code Mode"
}

export function readMcpCodeModeCalls(metadata: Record<string, unknown>): McpCodeModeCall[] {
  if (!Array.isArray(metadata.toolCalls)) return []
  return metadata.toolCalls.slice(0, 64).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const call = value as Record<string, unknown>
    if (typeof call.tool !== "string" || !["running", "completed", "error"].includes(String(call.status))) return []
    return [
      {
        tool: call.tool.slice(0, 200),
        status: call.status as McpCodeModeCall["status"],
        input: typeof call.input === "string" ? call.input.slice(0, 2048) : undefined,
        error: typeof call.error === "string" ? call.error.slice(0, 2048) : undefined,
      },
    ]
  })
}
