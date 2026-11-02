import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { Config } from "@/config/config"
import { resolveExternalCli, externalTurnFailure } from "@/tool/external-cli"
import { parseCodexJsonl, applyCodexJsonlLine, createCodexLiveState } from "@/tool/codex_consult"
import { parseClaudeJsonl } from "@/tool/claude_consult"
import { applyDshJsonlLine, createDshJsonState, dshCapabilities, type DshEventItem } from "@/tool/dsh-protocol"
import { buildDshExecArgs, buildDshFollowupArgs } from "@/tool/dsh_consult"
import { tmpdir } from "../fixture/fixture"

describe("external CLI runtime configuration", () => {
  for (const id of ["codex", "claude", "dsh", "grok"] as const) {
    test(id + " persists a partial configuration and uses the configured executable/home", () => {
      const config = { enabled: true, binaryPath: "/configured/" + id, configHome: "~/custom-agent-home" }
      const decoded = Schema.decodeUnknownSync(Config.Info)({ external_agents: { [id]: config } })
      expect(decoded.external_agents?.[id]).toEqual(config)
      const runtime = resolveExternalCli(id, config, {})
      expect(runtime.binary).toBe(config.binaryPath)
      expect(runtime.home).toBe(path.join(homedir(), "custom-agent-home"))
      expect(Object.values(runtime.env)).toEqual([runtime.home])
      expect(() => resolveExternalCli(id, { ...config, enabled: false }, {})).toThrow("disabled")
    })
  }

  test("desktop startup defaults migrate, but live backend overrides win, including empty paths", () => {
    const env = {
      OPENCODE_EXTERNAL_AGENTS: JSON.stringify({
        codex: { enabled: true, binaryPath: "/old/codex", configHome: "/old/home" },
      }),
    }
    expect(resolveExternalCli("codex", undefined, env).binary).toBe("/old/codex")
    expect(resolveExternalCli("codex", { binaryPath: "/new/codex", configHome: "" }, env).home).toBe(
      path.join(homedir(), ".codex"),
    )
    expect(resolveExternalCli("codex", { binaryPath: "/new/codex" }, env).binary).toBe("/new/codex")
  })

  test("desktop relative paths match main-process probes rather than the sidecar cwd", () => {
    const runtime = resolveExternalCli(
      "codex",
      { binaryPath: "./bin/codex", configHome: "custom-home" },
      { OPENCODE_CLIENT: "desktop" },
    )
    expect(runtime.binary).toBe(path.join(homedir(), "bin/codex"))
    expect(runtime.home).toBe(path.join(homedir(), "custom-home"))
  })

  test("Grok honors GROK_HOME and finds its managed binary when PATH has no Grok", async () => {
    await using dir = await tmpdir()
    const binary = path.join(dir.path, "bin", process.platform === "win32" ? "grok.exe" : "grok")
    await mkdir(path.dirname(binary), { recursive: true })
    await writeFile(binary, "fixture")
    const env = { PATH: "", GROK_HOME: dir.path }
    const runtime = resolveExternalCli("grok", undefined, env)
    expect(runtime.binary).toBe(binary)
    expect(runtime.env.GROK_HOME).toBe(dir.path)
    expect(() => resolveExternalCli("grok", { binaryPath: "missing-grok-fixture" }, env)).toThrow("not found")
  })
})

describe("external CLI terminal outcomes", () => {
  const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n")

  test("Codex top-level errors are captured, and successful recovery clears them", () => {
    expect(parseCodexJsonl(jsonl([{ type: "error", message: "Authentication failed" }])).error).toBe(
      "Authentication failed",
    )
    const state = createCodexLiveState()
    applyCodexJsonlLine(state, JSON.stringify({ type: "error", message: "Connection retry" }))
    applyCodexJsonlLine(state, JSON.stringify({ type: "turn.completed", usage: {} }))
    expect(state.completed).toBe(true)
    expect(state.error).toBeUndefined()
    applyCodexJsonlLine(state, JSON.stringify({ type: "turn.started" }))
    expect(state.completed).toBe(false)
  })

  test("Claude retains concrete error reasons and does not treat recovered tool errors as turn failures", () => {
    const failed = parseClaudeJsonl(
      jsonl([
        {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["Reached maximum turns", "Retry with more turns"],
        },
      ]),
    )
    expect(failed.completed).toBe(false)
    expect(failed.error).toBe("Reached maximum turns\nRetry with more turns")
    const recovered = parseClaudeJsonl(
      jsonl([
        {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: "read", is_error: true, content: "File missing" }] },
        },
        { type: "result", subtype: "success", is_error: false, result: "Found a different file" },
      ]),
    )
    expect(recovered.completed).toBe(true)
    expect(recovered.error).toBeUndefined()
  })

  test("partial answers, zero-exit diagnostics and unterminated streams cannot become successful replies", () => {
    const base = { advisor: "fixture", exitCode: 0, completed: true, answer: "partial", stderr: "" }
    expect(externalTurnFailure(base)).toBeUndefined()
    expect(externalTurnFailure({ ...base, exitCode: 1 })).toContain("exit 1")
    expect(externalTurnFailure({ ...base, error: "Quota exceeded" })).toContain("Quota exceeded")
    expect(externalTurnFailure({ ...base, completed: false })).toContain("terminal event")
    expect(externalTurnFailure({ ...base, answer: "", stderr: "diagnostic" })).toContain("empty response")
  })
})

describe("DSH JSON protocol and native resume", () => {
  test("detects capabilities rather than relying on a version number", () => {
    expect(dshCapabilities("Options:\n  --json  emit events\n  --session-id <id> resume")).toEqual({
      json: true,
      resume: true,
    })
    expect(dshCapabilities("Usage: dsh [task]")).toEqual({ json: false, resume: false })
  })

  test("native resume keeps the opaque session id and patches without replaying bounded history", () => {
    const initial = buildDshExecArgs({ prompt: "review", json: true })
    expect(initial).toContain("--json")
    const args = buildDshFollowupArgs({
      history: [{ role: "assistant", text: "old context".repeat(10000) }],
      followup: "--literal prompt",
      profile: "custom",
      patch: ["/a.patch"],
      json: true,
      sessionId: "session opaque id",
    })
    expect(args).toEqual([
      "--profile",
      "custom",
      "--patch",
      "/a.patch",
      "--json",
      "--session-id",
      "session opaque id",
      "--",
      "--literal prompt",
    ])
  })

  test("preserves lossless final text, tool progress and the session identity", () => {
    const state = createDshJsonState()
    const items: DshEventItem[] = []
    state.onItem = (item) => items.push(item)
    const full = "full answer ".repeat(2000)
    for (const event of [
      { type: "session", sessionId: "session-123" },
      { type: "status", phase: "turn_start" },
      { type: "thinking", text: "Thinking" },
      { type: "tool_call", callId: "read", tool: "read_file", input: { path: "/repo/file" } },
      { type: "tool_result", callId: "read", status: "completed", result: "contents" },
      { type: "text", text: full.slice(0, 8000), truncated: true },
      { type: "status", phase: "turn_end", reason: { kind: "completed" } },
      { type: "final", text: full },
    ])
      expect(applyDshJsonlLine(state, JSON.stringify(event))).toBe(true)
    expect(state.sessionId).toBe("session-123")
    expect(state.answer).toBe(full)
    expect(state.completed && state.final).toBe(true)
    expect(items.some((item) => item.kind === "tool_use")).toBe(true)
    expect(items.at(-1)?.text).toBe(full)
  })

  test("a final event does not turn an error or missing turn_end into success", () => {
    for (const reason of [undefined, { kind: "aborted" }, { kind: "error", error: { message: "Invalid key" } }]) {
      const state = createDshJsonState()
      if (reason) applyDshJsonlLine(state, JSON.stringify({ type: "status", phase: "turn_end", reason }))
      applyDshJsonlLine(state, JSON.stringify({ type: "final", text: "partial answer" }))
      expect(state.completed).toBe(false)
    }
    const state = createDshJsonState()
    expect(applyDshJsonlLine(state, "not JSON")).toBe(false)
    applyDshJsonlLine(state, JSON.stringify({ type: "error", message: "Startup failed" }))
    expect(state.error).toBe("Startup failed")
    expect(state.final).toBe(false)
  })
})
