import type { AgentCapabilities, McpServer } from "@agentclientprotocol/sdk"
import * as Log from "@opencode-ai/core/util/log"
import type { ConfigMCP } from "@/config/mcp"

const log = Log.create({ service: "agent-backend.mcp" })

export type McpConfig = Record<string, ConfigMCP.Info | { enabled: boolean }>

/**
 * Translate OpenCode MCP configuration into ACP `mcpServers`.
 * OAuth-protected remote servers are skipped: ACP has no client-side OAuth flow.
 */
export function acpMcpServers(input: {
  servers: McpConfig | undefined
  allow?: "all" | string[] | false
  capabilities?: AgentCapabilities | null
}): McpServer[] {
  const allow = input.allow ?? "all"
  if (allow === false || !input.servers) return []
  const allowed = allow === "all" ? undefined : new Set(allow)
  const out: McpServer[] = []
  const skipped: string[] = []
  for (const [name, value] of Object.entries(input.servers)) {
    if (allowed && !allowed.has(name)) continue
    if (!("type" in value)) {
      skipped.push(`${name}:legacy`)
      continue
    }
    if (value.enabled === false) {
      skipped.push(`${name}:disabled`)
      continue
    }
    if (value.type === "local") {
      const [command, ...args] = value.command
      if (!command) {
        skipped.push(`${name}:empty-command`)
        continue
      }
      out.push({
        name,
        command,
        args,
        env: Object.entries(value.environment ?? {}).map(([key, val]) => ({ name: key, value: val })),
      })
      continue
    }
    if (value.oauth) {
      skipped.push(`${name}:oauth`)
      continue
    }
    const type = input.capabilities?.mcpCapabilities?.http
      ? ("http" as const)
      : input.capabilities?.mcpCapabilities?.sse
        ? ("sse" as const)
        : undefined
    if (!type) {
      skipped.push(`${name}:transport`)
      continue
    }
    out.push({
      name,
      type,
      url: value.url,
      headers: Object.entries(value.headers ?? {}).map(([key, val]) => ({ name: key, value: val })),
    })
  }
  log.info(
    `exposed count=${out.length} names=${out.map((item) => item.name).join(",") || "none"} skipped=${skipped.join(",") || "none"}`,
  )
  return out
}

export * as McpServers from "./mcp-servers"
