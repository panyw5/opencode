import { describe, expect } from "bun:test"
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { DshConsultTool } from "@/tool/dsh_consult"
import { Truncate } from "@/tool/truncate"
import type { Tool } from "@/tool/tool"
import {
  advisorInterventionSnapshot,
  startAdvisorIntervention,
  sendAdvisorIntervention,
  finishAdvisorIntervention,
} from "@/tool/advisor-intervention"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(Agent.defaultLayer, Truncate.defaultLayer, AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer),
)
const run = process.platform === "win32" ? it.instance.skip : it.instance

type Call = { args: string[]; cwd: string; patches: string[] }

const fixture = async (directory: string) => {
  const binaryPath = path.join(directory, "installed-dsh")
  const configHome = path.join(directory, "dsh-home")
  await mkdir(configHome)
  await copyFile(path.join(import.meta.dir, "fixtures/dsh-consult-cli.js"), binaryPath)
  await chmod(binaryPath, 0o700)
  return { binaryPath, configHome, enabled: true }
}

describe("DSH installed-CLI process invocation", () => {
  run("saved defaults reach the child process and native follow-ups repeat permissions", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const config = yield* Effect.promise(() => fixture(instance.directory))
      const roots = path.join(instance.directory, "extra")
      yield* Effect.promise(() => mkdir(roots))
      const defaults = {
        profile: "review",
        working_directory: instance.directory,
        timeout_ms: 90000,
        permission_mode: "workspace-write",
        approval_policy: "never" as const,
        additional_writable_roots: [roots],
        patch: ["- id: one\n  disabled: true", "- id: two\n  disabled: false"],
      }
      const info = yield* DshConsultTool.pipe(
        Effect.provide(
          Layer.mock(Config.Service, {
            get: () => Effect.succeed({ external_agents: { dsh: { ...config, defaults } } }),
          }),
        ),
      )
      const tool = yield* info.init()
      const sessionID = SessionID.make("ses_dsh_process")
      const requests: string[] = []
      let turns = 0
      let activated = false
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_dsh_process"),
        callID: "call_dsh_process",
        agent: "build",
        messages: [],
        abort: AbortSignal.timeout(10000),
        ask: (request) =>
          Effect.sync(() => {
            requests.push(request.permission)
          }),
        metadata: (update) =>
          Effect.sync(() => {
            const target = { sessionID, callID: "call_dsh_process" }
            if (!advisorInterventionSnapshot(target)) return
            if (!activated) {
              activated = true
              startAdvisorIntervention(target)
            }
            if (!update.metadata?.intervention?.waitingForInput) return
            const turn = turns++
            queueMicrotask(() => {
              if (turn === 0) sendAdvisorIntervention({ ...target, message: "Follow-up question" })
              else finishAdvisorIntervention(target)
            })
          }),
      }
      const result = yield* tool.execute({ prompt: "Initial question" }, ctx)
      expect(result.output).toContain("Follow-up fixture answer")
      const calls: Call[] = (yield* Effect.promise(() => readFile(path.join(config.configHome, "calls.jsonl"), "utf8")))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.cwd).toBe(instance.directory)
        expect(call.args.slice(0, 2)).toEqual(["--profile", "review"])
        expect(call.patches).toEqual(defaults.patch.map((patch) => patch + "\n"))
        const mode = call.args.indexOf("--permission-mode")
        expect(call.args.slice(mode, mode + 6)).toEqual([
          "--permission-mode",
          "workspace-write",
          "--approval-policy",
          "never",
          "--add-dir",
          roots,
        ])
      }
      expect(calls[1].args.slice(-4)).toEqual(["--session-id", "session-dsh-fixture", "--", "Follow-up question"])
      expect(requests).toContain("dsh_consult")
      expect(result.metadata.permission_mode).toBe("workspace-write")
      expect(result.metadata.timeout_ms).toBe(90000)
    }),
  )

  run("single-call overrides clear patches and grants without modifying saved defaults", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const config = yield* Effect.promise(() => fixture(instance.directory))
      const defaults = {
        profile: "review",
        patch: ["[]"],
        permission_mode: "workspace-write",
        additional_writable_roots: ["/saved-root"],
      }
      const tool = yield* (yield* DshConsultTool.pipe(
        Effect.provide(
          Layer.mock(Config.Service, {
            get: () => Effect.succeed({ external_agents: { dsh: { ...config, defaults } } }),
          }),
        ),
      )).init()
      const result = yield* tool.execute(
        {
          prompt: "Override question",
          profile: "headless",
          permission_mode: "read-only",
          additional_writable_roots: [],
          patch: [],
        },
        {
          sessionID: SessionID.make("ses_dsh_override"),
          messageID: MessageID.make("msg_dsh_override"),
          agent: "build",
          messages: [],
          abort: AbortSignal.timeout(10000),
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )
      expect(result.output).toContain("Initial fixture answer")
      const call: Call = JSON.parse(
        (yield* Effect.promise(() => readFile(path.join(config.configHome, "calls.jsonl"), "utf8"))).trim(),
      )
      expect(call.args.slice(0, 4)).toEqual(["--profile", "headless", "--permission-mode", "read-only"])
      expect(call.args).not.toContain("--patch")
      expect(call.args).not.toContain("--add-dir")
      expect(defaults.patch).toEqual(["[]"])
    }),
  )

  run("unsupported installed CLI permissions fail before a task is submitted", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const config = yield* Effect.promise(() => fixture(instance.directory))
      yield* Effect.promise(() => writeFile(path.join(config.configHome, "legacy"), ""))
      const tool = yield* (yield* DshConsultTool.pipe(
        Effect.provide(
          Layer.mock(Config.Service, {
            get: () =>
              Effect.succeed({ external_agents: { dsh: { ...config, defaults: { permission_mode: "read-only" } } } }),
          }),
        ),
      )).init()
      const result = yield* Effect.exit(
        tool.execute(
          { prompt: "Must not be submitted" },
          {
            sessionID: SessionID.make("ses_dsh_legacy"),
            messageID: MessageID.make("msg_dsh_legacy"),
            agent: "build",
            messages: [],
            abort: AbortSignal.timeout(10000),
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("--permission-mode")
      expect(yield* (yield* AppFileSystem.Service).exists(path.join(config.configHome, "calls.jsonl"))).toBe(false)
    }),
  )
})
