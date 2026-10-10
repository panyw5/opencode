import { describe, expect } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import { mkdir, readFile, readdir, symlink, truncate, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
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
import * as Log from "@opencode-ai/core/util/log"

const calls: Array<{ owner: string; input: GptProCommand }> = []
const attachmentBytes = new Map<string, Buffer>()
const attachmentModes = new Map<string, { file: number; directory: number; root: number }>()
let phase: GptProPhase = "completed"
let recovery = false
let queueReason: GptProJob["queueReason"]
const browser = Layer.mock(Browser.Service, {
  gptPro: (owner, input) =>
    Effect.sync(() => {
      calls.push({ owner, input })
      for (const attachment of input.attachments ?? []) {
        attachmentBytes.set(attachment.name, readFileSync(attachment.path))
        attachmentModes.set(attachment.name, {
          file: statSync(attachment.path).mode & 0o777,
          directory: statSync(path.dirname(attachment.path)).mode & 0o777,
          root: statSync(path.dirname(path.dirname(attachment.path))).mode & 0o777,
        })
      }
      return {
        id: "gpt_test",
        owner,
        requestID: "request",
        phase,
        queueReason,
        ...(queueReason === "owner_busy" ? { queueOwnerConsultationID: "gpt_owner_job" } : {}),
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
      attachmentBytes.clear()
      attachmentModes.clear()
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
        expect(calls.some((call) => call.input.action === "stop")).toBe(false)
      } finally {
        phase = "completed"
      }
    }),
  )
  it.instance("returns the queue reason through live tool metadata and final output", () =>
    Effect.gen(function* () {
      calls.length = 0
      phase = "queued"
      queueReason = "capacity"
      try {
        const c = context()
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* tool.execute({ prompt: "Wait for a slot", background: true }, c.ctx)
        expect(result.metadata).toMatchObject({ phase: "queued", queue_reason: "capacity" })
        expect(JSON.parse(result.output)).toMatchObject({ phase: "queued", queue_reason: "capacity" })
      } finally {
        phase = "completed"
        queueReason = undefined
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
      expect(calls.some((call) => call.input.action === "stop")).toBe(false)
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
      const result = yield* tool.execute({ prompt: "Review", files: ["notes.md", pathToFileURL(filepath).href] }, c.ctx)
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
  it.instance("normalizes and stages direct data parts in private scoped temp storage", () =>
    Effect.gen(function* () {
      calls.length = 0
      attachmentBytes.clear()
      attachmentModes.clear()
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            filename: "fixture-notes.md",
            mime: "text/plain",
            url: `data:text/plain;base64,${Buffer.from("# Fixture notes\nKeep the original bytes.\n").toString("base64")}`,
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* tool.execute({ prompt: "Review this attachment" }, c.ctx)
      const attachment = calls[0]?.input.attachments?.[0]
      expect(attachment).toMatchObject({ name: "fixture-notes.md", mime: "text/markdown" })
      expect(attachment?.path).toContain(os.tmpdir())
      expect(yield* Effect.promise(() => Bun.file(attachment!.path).exists())).toBe(false)
      expect(attachmentBytes.get("fixture-notes.md")?.toString("utf8")).toBe(
        "# Fixture notes\nKeep the original bytes.\n",
      )
      expect(attachmentModes.get("fixture-notes.md")).toEqual({ file: 0o600, directory: 0o700, root: 0o700 })
      expect(c.asks).toEqual(["gpt_pro_consult"])
      expect(JSON.parse(result.output).attachments[0].name).toBe("fixture-notes.md")
      expect(JSON.parse(result.output).attachments[0].path).toBeUndefined()
      expect(result.metadata.attachments[0].path).toBeUndefined()
      let logOutput = ""
      for (let attempt = 0; attempt < 20; attempt++) {
        logOutput = yield* Effect.promise(() => readFile(Log.file(), "utf8").catch(() => ""))
        if (logOutput.includes("private attachment staging cleaned")) break
        yield* Effect.sleep("10 millis")
      }
      expect(logOutput).toContain("private attachment staging cleaned")
    }),
  )
  it.instance("rejects text/plain data parts with binary filenames before dispatch and removes all staged data", () =>
    Effect.gen(function* () {
      calls.length = 0
      for (const filename of ["fixture.png", "fixture.pdf"]) {
        const c = context()
        c.ctx.extra = {
          gptProAttachmentParts: [
            {
              type: "file",
              filename,
              mime: "text/plain",
              url: `data:text/plain;base64,${Buffer.from("not binary").toString("base64")}`,
            },
          ],
        }
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
        expect(Exit.isFailure(result)).toBe(true)
        expect(calls).toHaveLength(0)
        expect(c.asks).toEqual([])
      }
    }),
  )
  it.instance("rejects unknown MIME data without a filename before authorization or staging", () =>
    Effect.gen(function* () {
      calls.length = 0
      const before = new Set(
        (yield* Effect.promise(() => readdir(os.tmpdir()))).filter((name) => name.startsWith("opencode-gpt-pro-")),
      )
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            mime: "application/x-unknown",
            url: `data:application/x-unknown;base64,${Buffer.from("unknown").toString("base64")}`,
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(c.asks).toEqual([])
      expect(calls).toHaveLength(0)
      const after = (yield* Effect.promise(() => readdir(os.tmpdir()))).filter((name) =>
        name.startsWith("opencode-gpt-pro-"),
      )
      expect(after.filter((name) => !before.has(name))).toEqual([])
    }),
  )
  it.instance("rejects invalid or oversized display filenames before authorization", () =>
    Effect.gen(function* () {
      calls.length = 0
      for (const filename of [`bad\0name.txt`, `${"a".repeat(240)}.txt`]) {
        const c = context()
        c.ctx.extra = {
          gptProAttachmentParts: [
            {
              type: "file",
              filename,
              mime: "text/plain",
              url: `data:text/plain;base64,${Buffer.from("text").toString("base64")}`,
            },
          ],
        }
        const tool = yield* (yield* GptProConsultTool).init()
        const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
        expect(Exit.isFailure(result)).toBe(true)
        expect(c.asks).toEqual([])
      }
      expect(calls).toHaveLength(0)
    }),
  )
  it.instance("rejects direct file source and URL identity mismatches before authorization", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const source = path.join(instance.directory, "source.md")
      const other = path.join(instance.directory, "other.md")
      yield* Effect.tryPromise({
        try: async () => {
          await writeFile(source, "source")
          await writeFile(other, "other")
        },
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            filename: "source.md",
            mime: "text/plain",
            url: pathToFileURL(other).href,
            source: { type: "file", path: source },
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(c.asks).toEqual([])
      expect(calls).toHaveLength(0)
    }),
  )
  it.instance("preserves the requested filename for a local symbolic-link alias", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const target = path.join(instance.directory, "actual.md")
      const alias = path.join(instance.directory, "requested.txt")
      yield* Effect.tryPromise({
        try: async () => {
          await writeFile(target, "plain text bytes")
          await symlink(target, alias)
        },
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            filename: "requested.txt",
            mime: "text/plain",
            url: pathToFileURL(alias).href,
            source: { type: "file", path: alias },
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* tool.execute({ prompt: "Review" }, c.ctx)
      expect(calls[0]?.input.attachments?.[0]).toMatchObject({ name: "requested.txt", mime: "text/plain" })
      expect(JSON.parse(result.output).attachments[0].name).toBe("requested.txt")
    }),
  )
  it.instance("derives a raw file part filename from its file URL when none is provided", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const filepath = path.join(instance.directory, "url-fallback.md")
      yield* Effect.tryPromise({ try: () => writeFile(filepath, "fallback text"), catch: (error) => error }).pipe(
        Effect.orDie,
      )
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [{ type: "file", mime: "text/plain", url: `file://localhost${filepath}` }],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      yield* tool.execute({ prompt: "Review" }, c.ctx)
      expect(calls[0]?.input.attachments?.[0]).toMatchObject({ name: "url-fallback.md", mime: "text/markdown" })
    }),
  )
  it.instance("rejects non-file source descriptors even when their URL contains local data", () =>
    Effect.gen(function* () {
      calls.length = 0
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            filename: "resource.txt",
            mime: "text/plain",
            url: `data:text/plain;base64,${Buffer.from("resource").toString("base64")}`,
            source: { type: "resource" },
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(c.asks).toEqual([])
      expect(calls).toHaveLength(0)
    }),
  )
  it.instance("rejects file URLs with remote hosts", () =>
    Effect.gen(function* () {
      calls.length = 0
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          { type: "file", filename: "remote.md", mime: "text/plain", url: "file://remote.invalid/share/remote.md" },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(c.asks).toEqual([])
      expect(calls).toHaveLength(0)
    }),
  )
  it.instance("deduplicates canonical paths before applying the attachment count limit", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const files = Array.from({ length: 10 }, (_, index) => path.join(instance.directory, `count-${index}.txt`))
      yield* Effect.tryPromise({
        try: async () => Promise.all(files.map((file, index) => writeFile(file, `content-${index}`))),
        catch: (error) => error,
      }).pipe(Effect.orDie)
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* tool.execute({ prompt: "Review", files: [...files, files[0]!] }, context().ctx)
      expect(JSON.parse(result.output).attachments).toHaveLength(10)
    }),
  )
  it.instance("validates every direct part before authorizing or dispatching any source", () =>
    Effect.gen(function* () {
      calls.length = 0
      const instance = yield* TestInstance
      const existing = path.join(instance.directory, "present.md")
      const missing = path.join(instance.directory, "missing.md")
      yield* Effect.tryPromise({ try: () => writeFile(existing, "present"), catch: (error) => error }).pipe(
        Effect.orDie,
      )
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            filename: "present.md",
            mime: "text/plain",
            url: pathToFileURL(existing).href,
            source: { type: "file", path: existing },
          },
          {
            type: "file",
            filename: "missing.md",
            mime: "text/plain",
            url: pathToFileURL(missing).href,
            source: { type: "file", path: missing },
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(c.asks).toEqual([])
      expect(calls).toHaveLength(0)
    }),
  )
  it.instance("cleans private staged data after a later content validation failure", () =>
    Effect.gen(function* () {
      calls.length = 0
      const before = new Set(
        (yield* Effect.promise(() => readdir(os.tmpdir()))).filter((name) => name.startsWith("opencode-gpt-pro-")),
      )
      const c = context()
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            filename: "valid.md",
            mime: "text/plain",
            url: `data:text/plain;base64,${Buffer.from("valid markdown").toString("base64")}`,
          },
          {
            type: "file",
            filename: "invalid.pdf",
            mime: "application/pdf",
            url: `data:application/pdf;base64,${Buffer.from("not a pdf").toString("base64")}`,
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(calls).toHaveLength(0)
      const after = (yield* Effect.promise(() => readdir(os.tmpdir()))).filter((name) =>
        name.startsWith("opencode-gpt-pro-"),
      )
      expect(after.filter((name) => !before.has(name))).toEqual([])
    }),
  )
  it.instance("does not create private staging when GPT-Pro authorization is denied", () =>
    Effect.gen(function* () {
      calls.length = 0
      const before = new Set(
        (yield* Effect.promise(() => readdir(os.tmpdir()))).filter((name) => name.startsWith("opencode-gpt-pro-")),
      )
      const c = context(true)
      c.ctx.extra = {
        gptProAttachmentParts: [
          {
            type: "file",
            filename: "private.txt",
            mime: "text/plain",
            url: `data:text/plain;base64,${Buffer.from("private").toString("base64")}`,
          },
        ],
      }
      const tool = yield* (yield* GptProConsultTool).init()
      const result = yield* Effect.exit(tool.execute({ prompt: "Review" }, c.ctx))
      expect(Exit.isFailure(result)).toBe(true)
      expect(c.asks).toEqual(["gpt_pro_consult"])
      expect(calls).toHaveLength(0)
      const after = (yield* Effect.promise(() => readdir(os.tmpdir()))).filter((name) =>
        name.startsWith("opencode-gpt-pro-"),
      )
      expect(after.filter((name) => !before.has(name))).toEqual([])
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
