import { describe, expect, test } from "bun:test"
import { AcpAgentClient } from "../../src/agent-backend/acp-client"
import { AcpTranscript } from "../../src/agent-backend/acp-transcript"
import type { AcpConfig } from "../../src/agent-backend/schema"

const command = [process.execPath, `${import.meta.dir}/../fixture/acp-agent.mjs`]
const signal = () => AbortSignal.timeout(5000)

const make = (config: Partial<AcpConfig> = {}, options: { mcpServers?: any[]; keepAlive?: boolean } = {}) => {
  const live = new AcpTranscript()
  const client = new AcpAgentClient({
    config: { type: "acp", command, ...config },
    cwd: import.meta.dir,
    mcpServers: options.mcpServers,
    keepAlive: options.keepAlive,
    onEvent: (event) => live.apply(event),
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "reject" } }),
  })
  return { live, client }
}

describe("ACP client session channels", () => {
  test("resumes an existing agent session and forwards MCP servers", async () => {
    const { client, live } = make(
      { env: { ACP_FIXTURE_LOAD_SESSION: "1" } },
      { mcpServers: [{ name: "fixture-mcp", command: process.execPath, args: [], env: [] }], keepAlive: true },
    )
    try {
      await client.start(signal(), { resumeSessionID: "resume-me" })
      expect(client.sessionID).toBe("resume-me")
      live.beginTurn("loaded")
      await client.prompt("loaded", signal(), 1000)
      expect(live.text).toBe("SESSION=resume-me")
      live.beginTurn("mcp")
      await client.prompt("mcp", signal(), 1000)
      expect(live.text).toBe("MCP=fixture-mcp")
    } finally {
      await client.stop()
    }
  })

  test("starts a new agent session when loadSession is unsupported", async () => {
    const { client, live } = make({}, { keepAlive: true })
    try {
      await client.start(signal(), { resumeSessionID: "resume-me" })
      expect(client.sessionID).not.toBe("resume-me")
      live.beginTurn("hello")
      await client.prompt("hello", signal(), 1000)
      expect(live.text).toBe("ACP_REPLY_1: complete")
    } finally {
      await client.stop()
    }
  })

  test("reports stop reasons instead of throwing and keeps the process on abort", async () => {
    const { client, live } = make({}, { keepAlive: true })
    try {
      await client.start(signal())
      live.beginTurn("limit")
      const limited = await client.prompt("limit", signal(), 1000)
      expect(limited.stopReason).toBe("max_tokens")

      const controller = new AbortController()
      live.beginTurn("hang")
      const pending = client.prompt("hang", controller.signal, 5000)
      controller.abort()
      await expect(pending).rejects.toThrow("aborted")
      expect(client.alive).toBe(true)

      live.beginTurn("after")
      await client.prompt("after", signal(), 1000)
      expect(live.text).toBe("ACP_REPLY_3: complete")
    } finally {
      await client.stop()
    }
  })
})
