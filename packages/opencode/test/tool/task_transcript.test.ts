import { afterEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { Truncate } from "@/tool/truncate"
import { TaskTranscriptTool } from "../../src/tool/task_transcript"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(Agent.defaultLayer, Session.defaultLayer, Truncate.defaultLayer))

const addUserMessage = Effect.fn("TaskTranscriptTest.addUserMessage")(function* (
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

describe("tool.task_transcript", () => {
  it.instance("returns newest child task messages and paginates toward older history", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      yield* addUserMessage(child.id, "first", 1)
      yield* addUserMessage(child.id, "second", 2)
      yield* addUserMessage(child.id, "third", 3)

      const tool = yield* TaskTranscriptTool
      const def = yield* tool.init()
      const first = yield* def.execute({ task_id: child.id, limit: 2 }, context(parent.id))

      expect(first.output).toContain("second")
      expect(first.output).toContain("third")
      expect(first.output).not.toContain("first")
      expect(first.metadata.more).toBe(true)
      expect(first.metadata.next_cursor).toBeTruthy()

      const second = yield* def.execute(
        { task_id: child.id, limit: 2, cursor: first.metadata.next_cursor },
        context(parent.id),
      )
      expect(second.output).toContain("first")
      expect(second.metadata.more).toBe(false)
      expect(second.metadata.next_cursor).toBeUndefined()
    }),
  )

  it.instance("permits descendant tasks but rejects unrelated sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({ title: "Parent" })
      const child = yield* sessions.create({ parentID: parent.id, title: "Child" })
      const grandchild = yield* sessions.create({ parentID: child.id, title: "Grandchild" })
      const unrelated = yield* sessions.create({ title: "Unrelated" })
      const tool = yield* TaskTranscriptTool
      const def = yield* tool.init()

      const allowed = yield* def.execute({ task_id: grandchild.id }, context(parent.id))
      expect(allowed.output).toContain(`task_id: ${grandchild.id}`)

      const denied = yield* def.execute({ task_id: unrelated.id }, context(parent.id)).pipe(Effect.exit)
      expect(Exit.isFailure(denied)).toBe(true)
    }),
  )
})
