import { describe, expect, test } from "bun:test"
import { AcpAgentClient } from "../../src/agent-backend/acp-client"
import { AcpTranscript } from "../../src/agent-backend/acp-transcript"
import type { AcpConfig } from "../../src/agent-backend/schema"

const command = [process.execPath, `${import.meta.dir}/../fixture/acp-agent.mjs`]
const signal = () => AbortSignal.timeout(5000)
const make = (config: Partial<AcpConfig> = {}) => {
  const live = new AcpTranscript()
  const client = new AcpAgentClient({
    config: { type: "acp", command, ...config },
    cwd: import.meta.dir,
    onEvent: (event) => live.apply(event),
    requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "reject" } }),
  })
  return { live, client }
}

describe("ACP subprocess backend", () => {
  test("supports grouped session config options without legacy model methods", async () => {
    const { client } = make({ model: "fixture/other", env: { ACP_FIXTURE_CONFIG_OPTIONS: "1" } })
    try {
      await client.start(signal())
      expect(client.model).toBe("fixture/other")
    } finally {
      await client.stop()
    }
  })
  test("negotiates capabilities, selects model/mode, streams tools and reuses the session", async () => {
    const { client, live } = make({ model: "fixture/other", mode: "code" })
    try {
      await client.start(signal())
      expect(client.model).toBe("fixture/other")
      expect(client.capabilities).toMatchObject({ loadSession: false })
      const session = client.sessionID
      live.beginTurn("first")
      await client.prompt("first", signal(), 1000)
      expect(live.text).toBe("ACP_REPLY_1: complete")
      expect(live.transcript.map((item) => item.kind)).toEqual(["reasoning", "message", "tool", "message"])
      expect(live.transcript.find((item) => item.kind === "tool")).toMatchObject({
        title: "Read fixture",
        status: "completed",
        text: "fixture contents",
      })
      live.beginTurn("unicode")
      await client.prompt("unicode", signal(), 1000)
      expect(client.sessionID).toBe(session)
      expect(live.text).toBe("ACP_REPLY_2: \u4f60\u597d\u2028\u4e16\u754c")
      expect(live.transcript.filter((item) => item.kind === "user")).toMatchObject([{ text: "unicode" }])
      expect(new Set(live.transcript.map((item) => item.id)).size).toBe(live.transcript.length)
    } finally {
      await client.stop()
    }
  })

  test("supports bidirectional permission responses", async () => {
    const { client, live } = make()
    try {
      await client.start(signal())
      live.beginTurn("permission")
      await client.prompt("permission", signal(), 1000)
      expect(live.text).toBe("PERMISSION_reject")
    } finally {
      await client.stop()
    }
  })

  test("rejects missing executables, unsupported protocol and unadvertised model/mode", async () => {
    for (const [config, message] of [
      [{ command: ["/nonexistent/acp-fixture"] }, "startup failed"],
      [{ env: { ACP_FIXTURE_VERSION: "999" } }, "protocol version"],
      [{ model: "missing" }, "requested model"],
      [{ mode: "missing" }, "requested mode"],
    ] as const) {
      const { client } = make(config)
      try {
        await expect(client.start(signal())).rejects.toThrow(message)
      } finally {
        await client.stop()
      }
    }
  })

  for (const [prompt, message] of [
    ["bad", "Invalid ACP output"],
    ["hang", "timed out"],
    ["exit", /closed|exited/],
    ["limit", "max_tokens"],
  ]) {
    test(`reports ${prompt} without silently replaying the request`, async () => {
      const { client, live } = make()
      try {
        await client.start(signal())
        live.beginTurn(prompt!)
        await expect(client.prompt(prompt!, signal(), 100)).rejects.toThrow(message!)
      } finally {
        await client.stop()
      }
    })
  }

  test("cancels in-flight work and shuts down idempotently", async () => {
    const abort = new AbortController()
    const client = new AcpAgentClient({
      config: { type: "acp", command },
      cwd: import.meta.dir,
      onEvent: () => abort.abort(),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    })
    try {
      await client.start(signal())
      await expect(client.prompt("hang", abort.signal, 1000)).rejects.toThrow("aborted")
    } finally {
      await Promise.all([client.stop(), client.stop()])
    }
  })
  test("cancellation releases pending permission requests", async () => {
    const abort = new AbortController()
    let cancelled = false
    const client = new AcpAgentClient({
      config: { type: "acp", command },
      cwd: import.meta.dir,
      onEvent: () => {},
      requestPermission: async (_request, signal) => {
        const pending = new Promise<{ outcome: { outcome: "cancelled" } }>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled = true
              resolve({ outcome: { outcome: "cancelled" } })
            },
            { once: true },
          )
        })
        abort.abort()
        return pending
      },
    })
    try {
      await client.start(signal())
      await expect(client.prompt("permission", abort.signal, 1000)).rejects.toThrow("aborted")
      expect(cancelled).toBe(true)
    } finally {
      await client.stop()
    }
  })
})
