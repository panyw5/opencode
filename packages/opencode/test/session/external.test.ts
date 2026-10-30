import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { TaskTranscriptTool } from "@/tool/task_transcript"
import type { ExternalConsultationHandoff } from "@/session/external-handoff"
import { SessionStatus } from "@/session/status"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { externalSessionID, makeExternalSessions, type TranscriptItem } from "@/session/external"
import { registerAdvisorIntervention } from "@/tool/advisor-intervention"
import { dshTranscriptItem } from "@/tool/dsh_consult"
import type { Tool } from "@/tool/tool"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
  ),
)
const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }

const fixture = (name = "codex_consult") =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const parent = yield* sessions.create()
    const user = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: parent.id,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model,
    })
    const assistant = yield* sessions.updateMessage({
      id: MessageID.ascending(),
      sessionID: parent.id,
      role: "assistant",
      parentID: user.id,
      time: { created: Date.now() },
      agent: "build",
      mode: "build",
      ...model,
      path: { cwd: parent.directory, root: parent.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: parent.id,
      messageID: assistant.id,
      type: "tool",
      tool: name,
      callID: "call_test",
      state: { status: "running", input: { prompt: "Initial prompt" }, time: { start: Date.now() } },
    })
    const abort = new AbortController()
    const ctx: Tool.Context = {
      sessionID: parent.id,
      messageID: assistant.id,
      callID: part.callID,
      agent: "build",
      abort: abort.signal,
      messages: [],
      ask: () => Effect.void,
      metadata: ({ metadata }) =>
        sessions
          .updatePart({
            ...part,
            state: { ...part.state, status: "running", input: part.state.input, time: { start: Date.now() }, metadata },
          })
          .pipe(Effect.asVoid),
    }
    const api = makeExternalSessions(sessions, statuses)
    return {
      sessions,
      statuses,
      parent,
      part,
      assistant,
      ctx,
      abort,
      api,
      childID: externalSessionID(parent.id, part.id),
    }
  })

const tool = (execute: Tool.Def["execute"], id = "codex_consult"): Tool.Def => ({
  id,
  description: "fixture",
  parameters: Schema.Unknown,
  execute,
})

describe("external CLI child sessions", () => {
  it.instance("persists full event history, deduplicates updates and preserves multi-turn order", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const text = "x".repeat(12000)
      const wrapped = f.api.wrap(
        tool((_args, ctx) =>
          Effect.gen(function* () {
            const capture = ctx.extra!.externalTranscript as (item: TranscriptItem) => void
            for (let i = 0; i < 100; i++) capture({ id: `command:${i}`, kind: "command", text: `output ${i}` })
            capture({ id: "run1:reply", kind: "message", text, status: "running" })
            yield* ctx.metadata({
              metadata: { transcript: [{ id: "reply", kind: "message", text: "truncated", status: "running" }] },
            })
            capture({ id: "run1:reply", kind: "message", text, status: "completed" })
            capture({ id: "followup", kind: "user", text: "Follow up" })
            capture({ id: "reply2", kind: "message", text: "Second answer", status: "completed" })
            yield* ctx.metadata({ metadata: {} })
            return { title: "done", output: "Second answer", metadata: {} }
          }),
        ),
      )
      const result = yield* wrapped.execute({ prompt: "Initial prompt" }, f.ctx)
      expect(result.metadata.externalSessionID).toBe(f.childID)
      expect(result.metadata.interventionTurns).toBe(2)
      expect(result.output).not.toContain(text)
      expect(result.metadata.externalHandoff).toMatchObject({
        task_id: f.childID,
        user_intervened: true,
        read_before_summary: true,
      })
      expect(result.output).toContain("Initial prompt")
      expect(result.output).toContain("Follow up")
      expect(result.output).toContain("Second answer")
      expect(result.output).not.toContain("output 99")
      const child = yield* f.sessions.get(f.childID)
      expect(child.parentID).toBe(f.parent.id)
      expect(child.external).toMatchObject({ advisor: "codex", sourcePartID: f.part.id, historical: false })
      const messages = yield* f.sessions.messages({ sessionID: child.id })
      expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant", "user", "assistant"])
      expect(messages[1]!.parts.filter((part) => part.type === "tool")).toHaveLength(100)
      expect(messages[1]!.parts.find((part) => part.type === "text")).toMatchObject({ text })
      expect(messages[1]!.parts.filter((part) => part.type === "text")).toHaveLength(1)
      expect(messages[3]!.parts.find((part) => part.type === "text")).toMatchObject({ text: "Second answer" })
      expect((yield* f.statuses.get(child.id)).type).toBe("idle")
      expect((yield* f.api.control(child, "status")).available).toBe(false)
    }),
  )

  it.instance("directs the parent to read earlier news through task_transcript after a small-talk intervention", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const wrapped = f.api.wrap(
        tool((_args, ctx) =>
          Effect.gen(function* () {
            const capture = ctx.extra!.externalTranscript as (item: TranscriptItem) => void
            capture({
              id: "news",
              kind: "message",
              text: "Initial news with https://example.test/news",
              status: "completed",
            })
            for (let index = 0; index < 100; index++)
              capture({ id: `search:${index}`, kind: "web_search", text: "search diagnostics" })
            capture({ id: "science-question", kind: "user", text: "What interesting science news?" })
            capture({
              id: "science",
              kind: "message",
              text: "Science news with https://example.test/science",
              status: "completed",
            })
            capture({ id: "smalltalk-question", kind: "user", text: "Have you eaten?" })
            capture({ id: "smalltalk", kind: "message", text: "I do not eat.", status: "completed" })
            yield* ctx.metadata({
              metadata: { transcript: [{ id: "smalltalk", kind: "message", text: "I do not eat." }] },
            })
            return {
              title: "Codex",
              output: "<codex_consult>\nthread_id: thread-news\n</codex_consult>\n\nI do not eat.",
              metadata: {},
            }
          }),
        ),
      )
      const result = yield* wrapped.execute({ prompt: "What news today?" }, f.ctx)
      expect(result.output).toContain("thread_id: thread-news")
      expect(result.output).toContain("Initial news with https://example.test/news")
      expect(result.output).not.toContain("Science news with https://example.test/science")
      expect(result.output).toContain("I do not eat.")
      const handoff = result.metadata.externalHandoff as ExternalConsultationHandoff
      expect(handoff).toMatchObject({
        version: 1,
        task_id: f.childID,
        read_before_summary: true,
        delivery: "reference",
        user_turns: 3,
      })
      const reader = yield* TaskTranscriptTool
      const read = yield* reader.init()
      const transcript = yield* read.execute(handoff.read_transcript.arguments, f.ctx)
      expect(transcript.output).toContain("Initial news with https://example.test/news")
      expect(transcript.output).toContain("Science news with https://example.test/science")
      expect(transcript.output).toContain("Have you eaten?")
      expect(transcript.output).toContain("I do not eat.")
      expect(transcript.output).not.toContain("search diagnostics")
      expect(result.output).not.toContain("search diagnostics")
      expect(result.metadata.interventionTurns).toBe(3)
    }),
  )

  it.instance("normalizes the full handoff rather than bypassing output truncation", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      let normalized = ""
      const api = makeExternalSessions(f.sessions, f.statuses, (output) => {
        normalized = output
        return Effect.succeed({
          content: "Saved complete transcript: /tmp/consultation.txt",
          truncated: true,
          outputPath: "/tmp/consultation.txt",
        })
      })
      const result = yield* api
        .wrap(
          tool((_args, ctx) =>
            Effect.gen(function* () {
              const capture = ctx.extra!.externalTranscript as (item: TranscriptItem) => void
              capture({ id: "first", kind: "message", text: "First answer" })
              capture({ id: "question", kind: "user", text: "Second question" })
              capture({ id: "second", kind: "message", text: "Second answer" })
              return { title: "done", output: "Second answer", metadata: { truncated: false } }
            }),
          ),
        )
        .execute({ prompt: "Initial prompt" }, f.ctx)
      expect(normalized).toContain("First answer")
      expect(normalized).toContain("Second answer")
      expect(result.output).toBe("Saved complete transcript: /tmp/consultation.txt")
      expect(result.metadata).toMatchObject({
        truncated: true,
        outputPath: "/tmp/consultation.txt",
        interventionTurns: 2,
      })
    }),
  )

  it.instance("uses the full-history fallback when the parent cannot read task_transcript", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const api = makeExternalSessions(f.sessions, f.statuses, undefined, () => Effect.succeed(false))
      const result = yield* api
        .wrap(
          tool((_args, ctx) =>
            Effect.gen(function* () {
              const capture = ctx.extra!.externalTranscript as (item: TranscriptItem) => void
              capture({ id: "first", kind: "message", text: "First full answer" })
              capture({ id: "followup", kind: "user", text: "Follow-up question" })
              capture({ id: "second", kind: "message", text: "Second full answer" })
              return { title: "done", output: "Second full answer", metadata: {} }
            }),
          ),
        )
        .execute({ prompt: "Initial prompt" }, f.ctx)
      expect(result.metadata.externalHandoff).toMatchObject({
        user_intervened: true,
        delivery: "inline_fallback",
        read_before_summary: false,
      })
      expect(result.output).toContain("<consultation_history>")
      expect(result.output).toContain("First full answer")
      expect(result.output).toContain("Follow-up question")
      expect(result.output).toContain("Second full answer")
    }),
  )

  it.instance("remembers start and finish intervention even without an added user turn", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const result = yield* f.api
        .wrap(
          tool((_args, ctx) =>
            Effect.gen(function* () {
              registerAdvisorIntervention({ sessionID: ctx.sessionID, callID: ctx.callID!, advisor: "codex" })
              yield* ctx.metadata({
                metadata: { transcript: [{ id: "answer", kind: "message", text: "Original answer" }] },
              })
              const child = yield* f.sessions.get(f.childID)
              yield* f.api.control(child, "start")
              yield* f.api.control(child, "finish")
              return { title: "done", output: "Original answer", metadata: {} }
            }),
          ),
        )
        .execute({ prompt: "Initial prompt" }, f.ctx)
      expect(result.metadata.externalHandoff).toMatchObject({
        user_intervened: true,
        user_turns: 1,
        read_before_summary: true,
      })
    }),
  )

  it.instance("imports history once under concurrent clicks and does not execute GPT-Pro", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.sessions.updatePart({
        ...f.part,
        state: {
          status: "completed",
          input: { prompt: "Initial prompt" },
          title: "done",
          output: "Final answer",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      const results = yield* Effect.all(
        [
          f.api.importHistory(f.parent, f.assistant.id, f.part.id),
          f.api.importHistory(f.parent, f.assistant.id, f.part.id),
        ],
        { concurrency: "unbounded" },
      )
      expect(results[0]!.id).toBe(results[1]!.id)
      expect(yield* f.sessions.children(f.parent.id)).toHaveLength(1)
      expect(yield* f.sessions.messages({ sessionID: results[0]!.id })).toHaveLength(2)
      expect((yield* f.api.control(results[0]!, "status")).available).toBe(false)
      expect((yield* f.api.control(results[0]!, "start").pipe(Effect.exit))._tag).toBe("Failure")
      const gpt = tool(() => Effect.succeed({ title: "GPT", output: "untouched", metadata: {} }), "gpt_pro_consult")
      expect(f.api.wrap(gpt)).toBe(gpt)
    }),
  )

  it.instance("stops only the external execution, closes intervention, and preserves partial text", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const ready = yield* Deferred.make<void>()
      const wrapped = f.api.wrap(
        tool((_args, ctx) =>
          Effect.gen(function* () {
            registerAdvisorIntervention({ sessionID: ctx.sessionID, callID: ctx.callID!, advisor: "codex" })
            yield* ctx.metadata({
              metadata: { transcript: [{ id: "partial", kind: "message", text: "Partial answer" }] },
            })
            yield* Deferred.succeed(ready, undefined)
            yield* Effect.callback<void>((resume) => {
              const stop = () => resume(Effect.die(new Error("Stopped")))
              if (ctx.abort.aborted) {
                stop()
                return
              }
              ctx.abort.addEventListener("abort", stop, { once: true })
              return Effect.sync(() => ctx.abort.removeEventListener("abort", stop))
            })
            return { title: "done", output: "", metadata: {} }
          }),
        ),
      )
      const fiber = yield* Effect.forkChild(wrapped.execute({ prompt: "Initial prompt" }, f.ctx).pipe(Effect.exit))
      yield* Deferred.await(ready)
      const child = yield* f.sessions.get(f.childID)
      expect((yield* f.api.control(child, "start")).active).toBe(true)
      expect((yield* f.api.control(child, "stop")).stopping).toBe(true)
      expect((yield* Fiber.join(fiber))._tag).toBe("Failure")
      expect(f.abort.signal.aborted).toBe(false)
      const messages = yield* f.sessions.messages({ sessionID: child.id })
      expect(messages[1]!.parts.some((part) => part.type === "text" && part.text === "Partial answer")).toBe(true)
      expect(messages[1]!.info).toMatchObject({ error: { data: { message: "External consultation stopped" } } })
      expect((yield* f.api.control(child, "status")).available).toBe(false)
    }),
  )

  it.instance("does not finalize another live sidecar's child, but finalizes a disconnected owner", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      for (const [ownerPID, completed] of [
        [process.ppid, false],
        [99999999, true],
      ] as const) {
        const child = yield* f.sessions.create({
          parentID: f.parent.id,
          agent: "codex",
          external: {
            advisor: "codex",
            sourceMessageID: f.assistant.id,
            sourcePartID: f.part.id,
            callID: f.part.callID,
            historical: false,
            ownerPID,
          },
        })
        const user = yield* f.sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: child.id,
          role: "user",
          agent: "codex",
          model,
          time: { created: Date.now() },
        })
        yield* f.sessions.updateMessage({
          ...f.assistant,
          id: MessageID.ascending(),
          sessionID: child.id,
          parentID: user.id,
          time: { created: Date.now() },
        })
        expect((yield* f.api.control(child, "status")).available).toBe(false)
        const messages = yield* f.sessions.messages({ sessionID: child.id })
        expect(typeof messages[1]!.info.time.completed === "number").toBe(completed)
      }
    }),
  )

  it.instance("DSH creates one prompt and one answer per turn without clipping the stored reply", () =>
    Effect.gen(function* () {
      const f = yield* fixture("dsh_consult")
      const reply = "d".repeat(12000)
      yield* f.api
        .wrap(
          tool(
            (_args, ctx) =>
              Effect.gen(function* () {
                const capture = ctx.extra!.externalTranscript as (item: TranscriptItem) => void
                yield* ctx.metadata({
                  metadata: { transcript: [{ id: "user:initial", kind: "user", text: "Initial prompt" }] },
                })
                capture(dshTranscriptItem({ id: "assistant:live", kind: "message", text: "Partial" }, 0))
                yield* ctx.metadata({ metadata: {} })
                capture(
                  dshTranscriptItem({ id: "assistant:final", kind: "message", text: reply, status: "completed" }, 0),
                )
                capture({ id: "followup", kind: "user", text: "Second question" })
                capture(dshTranscriptItem({ id: "assistant:live", kind: "message", text: "Partial second" }, 1))
                capture(
                  dshTranscriptItem(
                    { id: "intervention-assistant:1", kind: "message", text: "Second answer", status: "completed" },
                    1,
                  ),
                )
                return { title: "done", output: "Second answer", metadata: {} }
              }),
            "dsh_consult",
          ),
        )
        .execute({ prompt: "Initial prompt" }, f.ctx)
      const messages = yield* f.sessions.messages({ sessionID: f.childID })
      expect(messages.map((message) => message.info.role)).toEqual(["user", "assistant", "user", "assistant"])
      expect(messages[1]!.parts.filter((part) => part.type === "text")).toEqual([
        expect.objectContaining({ text: reply }),
      ])
      expect(messages[3]!.parts.filter((part) => part.type === "text")).toEqual([
        expect.objectContaining({ text: "Second answer" }),
      ])
    }),
  )

  for (const name of ["claude_consult", "grok_consult", "dsh_consult", "pi_consult"]) {
    it.instance(`projects ${name} through the shared session interface`, () =>
      Effect.gen(function* () {
        const f = yield* fixture(name)
        const result = yield* f.api
          .wrap(
            tool(
              (_args, ctx) =>
                Effect.gen(function* () {
                  yield* ctx.metadata({
                    metadata: {
                      model: "actual-external-model",
                      transcript: [{ id: "reply", kind: "message", text: "Answer" }],
                    },
                  })
                  return { title: "done", output: "Answer", metadata: {} }
                }),
              name,
            ),
          )
          .execute({ prompt: "Initial prompt" }, f.ctx)
        expect((yield* f.sessions.get(f.childID)).external?.advisor).toBe(name.replace("_consult", ""))
        const messages = yield* f.sessions.messages({ sessionID: f.childID })
        expect(messages[1]!.info).toMatchObject({
          modelID: "actual-external-model",
          providerID: `external-${name.replace("_consult", "")}`,
        })
        expect(result.output.endsWith("\n\nAnswer")).toBe(true)
        expect(result.metadata.externalHandoff).toMatchObject({
          task_id: f.childID,
          user_intervened: false,
          read_before_summary: false,
        })
      }),
    )
  }
})
