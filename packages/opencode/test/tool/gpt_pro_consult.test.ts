import { describe, expect } from "bun:test"
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Browser } from "../../src/browser"
import { Truncate } from "../../src/tool/truncate"
import { GptProConsultTool } from "../../src/tool/gpt_pro_consult"
import { SessionID, MessageID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import type { GptProCommand, GptProJob, GptProPhase } from "@opencode-ai/util/gpt-pro"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const calls: Array<{ owner: string; input: GptProCommand }> = []
let phase: GptProPhase = "completed"
let recovery = false
const browser = Layer.mock(Browser.Service, {
  gptPro: (owner, input) =>
    Effect.sync(() => {
      calls.push({ owner, input })
      return {
        id: "gpt_test",
        owner,
        requestID: "request",
        phase,
        ...(recovery
          ? { recovery: { stage: "model" as const, reason: "Unknown picker" }, sendAttempted: false, submitted: false }
          : {}),
        background: input.background ?? input.action === "background",
        prompt: input.prompt ?? "Question",
        url: "https://chatgpt.com/c/test",
        createdAt: 1,
        updatedAt: 2,
        submitted: !recovery,
        revision: 1,
        model: "GPT-6 Pro",
        text: "Answer",
        html: "<p>Answer</p>",
      } satisfies GptProJob
    }),
})
const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Truncate.defaultLayer, browser))
function context(deny = false) {
  const asks: string[] = []
  const requests: Array<{ permission: string; metadata: Record<string, unknown> }> = []
  const updates: unknown[] = []
  const ctx: Tool.Context = {
    sessionID: SessionID.make("ses_gptpro"),
    messageID: MessageID.make("msg_gptpro"),
    callID: "call_test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: (value) =>
      Effect.sync(() => {
        updates.push(value)
      }),
    ask: (value) =>
      Effect.sync(() => {
        asks.push(value.permission)
        requests.push({ permission: value.permission, metadata: value.metadata })
        if (deny) throw new Error("denied")
      }),
  }
  return { ctx, asks, requests, updates }
}
describe("gpt_pro_consult tool", () => {
  it.instance(
    "foreground fixed-flow failure returns control to the model immediately with scoped browser guidance",
    () =>
      Effect.gen(function* () {
        phase = "paused"
        recovery = true
        calls.length = 0
        try {
          const tool = yield* (yield* GptProConsultTool).init()
          const result = yield* tool.execute({ prompt: "Original prompt", background: false }, context().ctx)
          const output = JSON.parse(result.output)
          expect(calls).toHaveLength(1)
          expect(output.recovery.stage).toBe("model")
          expect(output.managed_prompt).toBe("Original prompt")
          expect(output.send_attempted).toBe(false)
          expect(output.instruction).toContain("browser_* tools with consultation_id=gpt_test")
          expect(output.instruction).toContain("resume this same ID")
        } finally {
          phase = "completed"
          recovery = false
        }
      }),
  )
  it.instance("a failed background consultation never claims it is still running", () =>
    Effect.gen(function* () {
      calls.length = 0
      phase = "failed"
      try {
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* tool.execute(
          { action: "status", consultation_id: "gpt_test", background: true },
          context().ctx,
        )
        expect(JSON.parse(result.output).instruction).toContain("did not complete")
        expect(JSON.parse(result.output).instruction).not.toContain("running independently")
        expect(calls).toHaveLength(1)
      } finally {
        phase = "completed"
      }
    }),
  )
  it.instance("background returns while Pro is generating without any wait or poll", () =>
    Effect.gen(function* () {
      calls.length = 0
      phase = "generating"
      try {
        const c = context()
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* tool.execute({ prompt: "Long question", background: true }, c.ctx)
        expect(calls).toHaveLength(1)
        expect(calls[0].input.background).toBe(true)
        expect(JSON.parse(result.output)).toMatchObject({ background: true, phase: "generating" })
        expect(result.metadata.background).toBe(true)
        expect(JSON.parse(result.output).instruction).toContain("automatically")
      } finally {
        phase = "completed"
      }
    }),
  )
  it.instance("promotion preserves consultation ID and sends no prompt", () =>
    Effect.gen(function* () {
      calls.length = 0
      phase = "generating"
      try {
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* tool.execute({ action: "background", consultation_id: "gpt_test" }, context().ctx)
        expect(calls).toHaveLength(1)
        expect(calls[0].input).toMatchObject({ action: "background", id: "gpt_test", prompt: undefined })
        expect(result.metadata.background).toBe(true)
      } finally {
        phase = "completed"
      }
    }),
  )
  it.instance("asks permission, uses the current session owner, and returns final HTML", () =>
    Effect.gen(function* () {
      calls.length = 0
      const c = context()
      const info = yield* GptProConsultTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ prompt: "Question", wait_ms: 0 }, c.ctx)
      expect(c.asks).toEqual(["gpt_pro_consult"])
      expect(calls[0].owner.endsWith("\nses_gptpro")).toBe(true)
      expect(calls[0].input.requestID).toBe("ses_gptpro:call_test")
      expect(calls.at(-1)?.input.action).toBe("read")
      expect(JSON.parse(result.output).html).toBe("<p>Answer</p>")
      expect(result.metadata.consultation_id).toBe("gpt_test")
    }),
  )
  it.instance("permission denial dispatches no browser command", () =>
    Effect.gen(function* () {
      calls.length = 0
      const c = context(true)
      const info = yield* GptProConsultTool
      const tool = yield* info.init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Question" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(calls).toHaveLength(0)
    }),
  )
  it.instance("authorizes a regular file before hashing and forwards only metadata descriptors", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const filepath = path.join(instance.directory, "notes.md")
      yield* Effect.tryPromise({
        try: () => writeFile(filepath, "review the implementation"),
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const c = context()
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* tool.execute({ prompt: "Review", files: ["notes.md", "notes.md"] }, c.ctx)
      const descriptor = calls[0]?.input.attachments?.[0]
      expect(c.asks).toEqual(["read", "gpt_pro_consult"])
      expect(c.requests[1]?.metadata).toMatchObject({
        action: "attachments",
        target: "GPT-6 Pro (ChatGPT)",
        files: [{ name: "notes.md", size: 25 }],
      })
      expect(calls[0]?.input.attachments).toHaveLength(1)
      expect(descriptor).toMatchObject({ name: "notes.md", mime: "text/markdown", size: 25 })
      expect(descriptor?.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(result.output).attachments[0]).toMatchObject({ id: descriptor?.id, status: "pending" })
    }),
  )
  it.instance("keeps distinct same-name files while deduplicating an identical canonical path", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const a = path.join(instance.directory, "a", "notes.md")
      const b = path.join(instance.directory, "b", "notes.md")
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(path.dirname(a), { recursive: true })
          await mkdir(path.dirname(b), { recursive: true })
          await writeFile(a, "first")
          await writeFile(b, "second")
        },
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* tool.execute({ prompt: "Review", files: [a, b, a] }, context().ctx)
      const attachments = JSON.parse(result.output).attachments
      expect(attachments).toHaveLength(2)
      expect(attachments.map((item: { name: string }) => item.name)).toEqual(["notes.md", "notes.md"])
      expect(attachments[0].id).not.toBe(attachments[1].id)
    }),
  )
  it.instance("a denied attachment read never dispatches GPT-Pro", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const filepath = path.join(instance.directory, "private.txt")
      yield* Effect.tryPromise({ try: () => writeFile(filepath, "private"), catch: (error) => error }).pipe(
        Effect.orDie,
      )
      const c = context(true)
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review", files: [filepath] }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(calls).toHaveLength(0)
      expect(c.asks).toEqual(["read"])
    }),
  )
  it.instance("requires external-directory authorization for a symlink that escapes the workspace", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const link = path.join(instance.directory, "external.md")
      const target = path.resolve(import.meta.dir, "../../../../README.md")
      yield* Effect.tryPromise({ try: () => symlink(target, link), catch: (error) => error }).pipe(Effect.orDie)
      const c = context()
      const tool = yield* (yield* GptProConsultTool).init()
      yield* tool.execute({ prompt: "Review", files: [link] }, c.ctx)
      expect(c.asks).toEqual(["external_directory", "read", "gpt_pro_consult"])
      expect(c.requests[0]?.metadata.filepath).toBe(target)
    }),
  )
  it.instance("rejects unsupported extensions and invalid claimed media before dispatch", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const unsupported = path.join(instance.directory, "payload.bin")
      const invalidPdf = path.join(instance.directory, "payload.pdf")
      yield* Effect.tryPromise({
        try: async () => {
          await writeFile(unsupported, "not supported")
          await writeFile(invalidPdf, "not a PDF")
        },
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const tool = yield* (yield* GptProConsultTool).init()
      const unsupportedResult = yield* Effect.exit(
        tool.execute({ prompt: "Review", files: [unsupported] }, context().ctx),
      )
      expect(Exit.isFailure(unsupportedResult)).toBe(true)
      expect(calls).toHaveLength(0)
      const invalidPdfResult = yield* Effect.exit(
        tool.execute({ prompt: "Review", files: [invalidPdf] }, context().ctx),
      )
      expect(Exit.isFailure(invalidPdfResult)).toBe(true)
      expect(calls).toHaveLength(0)
    }),
  )
  it.instance("accepts UTF-8 text split across the sample boundary and rejects mismatched media extensions", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const validText = path.join(instance.directory, "boundary.md")
      const disguisedPdf = path.join(instance.directory, "disguised.md")
      yield* Effect.tryPromise({
        try: async () => {
          await writeFile(validText, `${"a".repeat(4095)}中`)
          await writeFile(disguisedPdf, "%PDF-1.7\nnot a markdown file")
        },
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const tool = yield* (yield* GptProConsultTool).init()
      const valid = yield* tool.execute({ prompt: "Review", files: [validText] }, context().ctx)
      expect(JSON.parse(valid.output).attachments[0].mime).toBe("text/markdown")
      const rejected = yield* Effect.exit(tool.execute({ prompt: "Review", files: [disguisedPdf] }, context().ctx))
      expect(Exit.isFailure(rejected)).toBe(true)
      expect(calls).toHaveLength(2)
    }),
  )
  it.instance("rejects missing, directory, and oversized attachments", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const directory = path.join(instance.directory, "folder.txt")
      const oversized = path.join(instance.directory, "large.txt")
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(directory)
          await writeFile(oversized, "")
          await truncate(oversized, 20 * 1024 * 1024 + 1)
        },
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const tool = yield* (yield* GptProConsultTool).init()
      for (const file of [path.join(instance.directory, "missing.txt"), directory, oversized]) {
        const rejected = yield* Effect.exit(tool.execute({ prompt: "Review", files: [file] }, context().ctx))
        expect(Exit.isFailure(rejected)).toBe(true)
      }
      expect(calls).toHaveLength(0)
    }),
  )
})
