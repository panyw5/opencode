import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { SessionTranscriptTool } from "../../src/tool/session_transcript"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer, Truncate.defaultLayer))

const addUserMessage = Effect.fn("SessionTranscriptTest.addUserMessage")(function* (
  sessionID: SessionID,
  text: string,
  created: number,
) {
  const sessions = yield* Session.Service
  const messageID = MessageID.ascending()
  yield* sessions.updateMessage({
    id: messageID,
    role: "user",
    sessionID,
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    time: { created },
  } as never)
  yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text",
    text,
  })
})

const context = (sessionID: SessionID) => ({
  sessionID,
  messageID: MessageID.ascending(),
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

describe("tool.session_transcript", () => {
  it.instance("reads an unrelated root session that task_transcript would reject", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reader = yield* sessions.create({ title: "Reader" })
      const target = yield* sessions.create({ title: "Unrelated root" })
      yield* addUserMessage(target.id, "hello from another session", 1)

      const tool = yield* SessionTranscriptTool
      const def = yield* tool.init()
      const result = yield* def.execute({ session_id: target.id }, context(reader.id))

      expect(result.output).toContain(`session_id: ${target.id}`)
      expect(result.output).toContain("title: Unrelated root")
      expect(result.output).toContain("hello from another session")
      expect(result.metadata.directory).toBe(target.directory)
      expect(result.metadata.parent_task_id).toBeUndefined()
    }),
  )

  it.instance("reads a child session regardless of parentage", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reader = yield* sessions.create({ title: "Reader" })
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      yield* addUserMessage(child.id, "child message", 1)

      const tool = yield* SessionTranscriptTool
      const def = yield* tool.init()
      const result = yield* def.execute({ session_id: child.id }, context(reader.id))

      expect(result.output).toContain("child message")
      expect(result.metadata.parent_task_id).toBe(parent.id)
    }),
  )

  it.instance("paginates toward older history", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reader = yield* sessions.create({ title: "Reader" })
      const target = yield* sessions.create({ title: "Target" })
      yield* addUserMessage(target.id, "first", 1)
      yield* addUserMessage(target.id, "second", 2)
      yield* addUserMessage(target.id, "third", 3)

      const tool = yield* SessionTranscriptTool
      const def = yield* tool.init()
      const first = yield* def.execute({ session_id: target.id, limit: 2 }, context(reader.id))

      expect(first.output).toContain("second")
      expect(first.output).toContain("third")
      expect(first.output).not.toContain("first")
      expect(first.metadata.more).toBe(true)
      expect(first.metadata.next_cursor).toBeTruthy()

      const second = yield* def.execute(
        { session_id: target.id, limit: 2, cursor: first.metadata.next_cursor },
        context(reader.id),
      )
      expect(second.output).toContain("first")
      expect(second.metadata.more).toBe(false)
      expect(second.metadata.next_cursor).toBeUndefined()
    }),
  )

  it.instance("reports an empty session instead of failing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reader = yield* sessions.create({ title: "Reader" })
      const target = yield* sessions.create({ title: "Empty" })

      const tool = yield* SessionTranscriptTool
      const def = yield* tool.init()
      const result = yield* def.execute({ session_id: target.id }, context(reader.id))

      expect(result.output).toContain("messages: 0")
      expect(result.output).toContain("No messages in this page.")
    }),
  )

  it.instance("fails for an unknown session id", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const reader = yield* sessions.create({ title: "Reader" })
      const tool = yield* SessionTranscriptTool
      const def = yield* tool.init()

      const exit = yield* def.execute({ session_id: "ses_missing" as SessionID }, context(reader.id)).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
