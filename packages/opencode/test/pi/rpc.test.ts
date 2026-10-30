import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { PiRpcClient, object, type PiRecord } from "../../src/pi/rpc"
import { PiTranscript } from "../../src/pi/transcript"

const binary = fileURLToPath(new URL("../fixture/pi-rpc.mjs", import.meta.url))
const make = () => new PiRpcClient({ binary, cwd: import.meta.dir })

describe("Pi RPC subprocess", () => {
  test("startup errors and cancellation reject promptly without leaking the child", async () => {
    const missing = new PiRpcClient({ binary: "/nonexistent/pi-fixture", cwd: import.meta.dir })
    console.info("[pi-rpc-test] checking missing executable")
    await expect(missing.start()).rejects.toThrow("Pi startup failed")
    console.info("[pi-rpc-test] checking startup cancellation")
    const abort = new AbortController()
    const waiting = new PiRpcClient({ binary, cwd: import.meta.dir, args: ["--delay-state"] })
    waiting.onEvent((event) => {
      if (event.type === "startup_waiting") abort.abort()
    })
    await expect(waiting.start(abort.signal)).rejects.toThrow("startup was aborted")
    await waiting.stop()
  })
  test("readiness handshake, correlated out-of-order responses, and same-process follow-ups", async () => {
    const client = make()
    try {
      const initial = await client.start()
      const values = await Promise.all([
        client.request({ type: "delayed", value: 1, delay: 25 }),
        client.request({ type: "delayed", value: 2, delay: 0 }),
      ])
      expect(values.map((value) => object(value.data)?.value)).toEqual([1, 2])
      const live = new PiTranscript()
      client.onEvent((event) => live.apply(event))
      await client.prompt("first")
      expect(live.text).toContain("PI_REPLY_1")
      live.beginTurn()
      await client.prompt("second")
      expect(live.text).toContain("PI_REPLY_2")
      expect(live.text).not.toContain("PI_REPLY_1")
      expect(live.transcript.filter((item) => item.kind === "user")).toMatchObject([{ text: "second" }])
      expect(object((await client.request({ type: "get_state" })).data)?.sessionId).toBe(
        object(initial.data)?.sessionId,
      )
      await expect(client.request({ type: "reject" })).rejects.toThrow("Rejected command")
      await expect(client.request({ type: "never" }, 20)).rejects.toThrow("timed out")
    } finally {
      await client.stop()
    }
  })

  test("strict LF framing preserves Unicode separators and fragmented UTF-8", async () => {
    const client = make()
    try {
      await client.start()
      const live = new PiTranscript()
      client.onEvent((event) => live.apply(event))
      await client.prompt("unicode")
      expect(live.text).toBe("你好\u2028世界\u2029done")
      expect(live.transcript.find((item) => item.kind === "tool_use")).toMatchObject({
        status: "completed",
        text: "fixture file contents",
      })
    } finally {
      await client.stop()
    }
  })

  test("waits past agent_end, accepts handled prompts, and surfaces provider errors", async () => {
    const client = make()
    try {
      await client.start()
      const events: PiRecord[] = []
      client.onEvent((event) => events.push(event))
      await client.prompt("retry")
      expect(events.some((event) => JSON.stringify(event).includes("RECOVERED_AFTER_AGENT_END"))).toBe(true)
      await client.prompt("handled", { timeoutMs: 100 })
      await expect(client.prompt("error")).rejects.toThrow("Provider fixture failed")
    } finally {
      await client.stop()
    }
  })

  for (const [prompt, expected] of [
    ["exit", "exited"],
    ["bad", "Invalid Pi RPC"],
    ["hang", "timed out"],
  ]) {
    test(`terminates and reports ${prompt}`, async () => {
      const client = make()
      try {
        await client.start()
        await expect(client.prompt(prompt!, { timeoutMs: 100 })).rejects.toThrow(expected!)
      } finally {
        await client.stop()
      }
    })
  }

  test("cancellation clears queues, aborts, and shuts down the child", async () => {
    const client = make()
    const abort = new AbortController()
    try {
      await client.start()
      client.onEvent((event) => {
        if (event.type === "agent_start") abort.abort()
      })
      await expect(client.prompt("hang", { signal: abort.signal })).rejects.toThrow("aborted")
      await expect(client.request({ type: "get_state" })).rejects.toThrow("exited")
    } finally {
      await client.stop()
    }
  })
})

describe("Pi transcript projection", () => {
  test("authoritative final blocks replace deltas while capture precedes preview limits", () => {
    const live = new PiTranscript()
    const captured = new Map<string, string>()
    live.onTranscript = (item) => captured.set(item.id, item.text ?? "")
    const full = "a".repeat(16000)
    live.apply({ type: "message_start", message: { role: "assistant" } })
    live.apply({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    })
    live.apply({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: full }], stopReason: "stop" },
    })
    expect(live.text).toBe(full)
    expect([...captured.values()]).toContain(full)
    expect(live.transcript[0]?.text?.length).toBe(8000)
    for (let i = 0; i < 100; i++)
      live.apply({ type: "tool_execution_start", toolCallId: String(i), toolName: "read", args: {} })
    expect(live.transcript).toHaveLength(80)
    expect(captured.size).toBe(101)
  })
})
