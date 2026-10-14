import { expect } from "bun:test"
import { Deferred, Effect, Layer, Fiber } from "effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { Session } from "@/session/session"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { MessageID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { disposeInstance } from "@/effect/instance-registry"

const dependencies = Layer.mergeAll(
  Layer.mock(Session.Service, {
    messages: () =>
      Effect.gen(function* () {
        messageReads += 1
        const snapshot = messages
        if (pauseFirstRead && messageReads === 1) {
          yield* Deferred.succeed(firstReadStarted, undefined)
          yield* Deferred.await(releaseFirstRead)
        }
        return snapshot
      }),
    setSummary: () => Effect.sync(() => void (summaryWrites += 1)),
    updateMessage: (info) => Effect.sync(() => void updatedMessages.add(info.id)),
  }),
  Layer.mock(Snapshot.Service, {
    diffFull: () =>
      Effect.gen(function* () {
        diffCalls += 1
        if (diffCalls === 1) {
          yield* Deferred.succeed(firstDiffStarted, undefined)
          yield* Deferred.await(releaseFirstDiff)
        }
        if (diffCalls === 2) {
          if (pauseSecondDiff) {
            yield* Deferred.succeed(secondDiffStarted, undefined)
            yield* Deferred.await(releaseSecondDiff)
          }
        }
        return []
      }),
  }),
  Layer.mock(Storage.Service, { write: () => Effect.void }),
  Layer.mock(Bus.Service, { publish: () => Effect.void }),
)
const it = testEffect(SessionSummary.layer.pipe(Layer.provide(dependencies)))

const sessionID = SessionID.make("ses_summary_coalesce")
const userA = MessageID.make("msg_summary_a")
const userB = MessageID.make("msg_summary_b")
const root = "/workspace"
const user = (id: MessageID) => ({ info: { id, sessionID, role: "user" }, parts: [] }) as unknown as MessageV2.WithParts
const assistant = (id: string, parentID: MessageID) =>
  ({
    info: { id: MessageID.make(id), sessionID, parentID, role: "assistant", path: { root, cwd: root } },
    parts: [
      { type: "step-start", id: `${id}_start`, snapshot: "from" },
      {
        type: "tool",
        tool: "edit",
        state: { status: "completed", input: {}, output: "", metadata: { filepath: `${root}/${id}.txt` } },
      },
      { type: "step-finish", id: `${id}_finish`, snapshot: "to" },
    ],
  }) as unknown as MessageV2.WithParts

let messages: MessageV2.WithParts[] = []
let diffCalls = 0
let summaryWrites = 0
let updatedMessages = new Set<MessageID>()
let firstDiffStarted: Deferred.Deferred<void>
let releaseFirstDiff: Deferred.Deferred<void>
let secondDiffStarted: Deferred.Deferred<void>
let releaseSecondDiff: Deferred.Deferred<void>
let pauseSecondDiff = false
let messageReads = 0
let pauseFirstRead = false
let firstReadStarted: Deferred.Deferred<void>
let releaseFirstRead: Deferred.Deferred<void>

it.instance("coalesces session summary requests and commits every pending user summary", () =>
  Effect.gen(function* () {
    diffCalls = 0
    summaryWrites = 0
    pauseSecondDiff = true
    updatedMessages = new Set()
    messages = [user(userA), assistant("msg_summary_assistant_a", userA)]
    firstDiffStarted = yield* Deferred.make<void>()
    releaseFirstDiff = yield* Deferred.make<void>()
    secondDiffStarted = yield* Deferred.make<void>()
    releaseSecondDiff = yield* Deferred.make<void>()

    const summary = yield* SessionSummary.Service
    const first = yield* summary.summarize({ sessionID, messageID: userA }).pipe(Effect.forkChild)
    yield* Deferred.await(firstDiffStarted)
    messages = [...messages, user(userB), assistant("msg_summary_assistant_b", userB)]
    yield* summary.summarize({ sessionID, messageID: userB })
    yield* Deferred.succeed(releaseFirstDiff, undefined)
    yield* Deferred.await(secondDiffStarted)
    expect(summaryWrites).toBe(1)
    yield* Deferred.succeed(releaseSecondDiff, undefined)
    yield* Fiber.join(first)

    expect(diffCalls).toBe(4)
    expect(summaryWrites).toBe(2)
    expect([...updatedMessages].sort()).toEqual([userA, userB].sort())
  }),
)

it.instance("keeps a message request queued while an older message read is in flight", () =>
  Effect.gen(function* () {
    diffCalls = 0
    summaryWrites = 0
    messageReads = 0
    pauseFirstRead = true
    pauseSecondDiff = false
    updatedMessages = new Set()
    messages = [user(userA), assistant("msg_summary_assistant_a", userA)]
    firstReadStarted = yield* Deferred.make<void>()
    releaseFirstRead = yield* Deferred.make<void>()
    firstDiffStarted = yield* Deferred.make<void>()
    releaseFirstDiff = yield* Deferred.make<void>()

    const summary = yield* SessionSummary.Service
    const first = yield* summary.summarize({ sessionID, messageID: userA }).pipe(Effect.forkChild)
    yield* Deferred.await(firstReadStarted)
    messages = [...messages, user(userB), assistant("msg_summary_assistant_b", userB)]
    yield* summary.summarize({ sessionID, messageID: userB })
    yield* Deferred.succeed(releaseFirstRead, undefined)
    yield* Deferred.await(firstDiffStarted)
    yield* Deferred.succeed(releaseFirstDiff, undefined)
    yield* Fiber.join(first)

    expect(messageReads).toBe(2)
    expect(diffCalls).toBe(4)
    expect([...updatedMessages].sort()).toEqual([userA, userB].sort())
    expect(summaryWrites).toBe(2)
  }),
)

it.instance("invalidates an in-flight summary before revert commits its replacement", () =>
  Effect.gen(function* () {
    diffCalls = 0
    summaryWrites = 0
    pauseSecondDiff = false
    pauseFirstRead = false
    messageReads = 0
    updatedMessages = new Set()
    messages = [user(userA), assistant("msg_summary_assistant_a", userA)]
    firstDiffStarted = yield* Deferred.make<void>()
    releaseFirstDiff = yield* Deferred.make<void>()

    const summary = yield* SessionSummary.Service
    const first = yield* summary.summarize({ sessionID, messageID: userA }).pipe(Effect.forkChild)
    yield* Deferred.await(firstDiffStarted)
    yield* summary.invalidate(sessionID)
    yield* Deferred.succeed(releaseFirstDiff, undefined)
    yield* Fiber.join(first)

    expect(summaryWrites).toBe(0)
    expect(updatedMessages.size).toBe(0)
  }),
)

it.instance("releases the single runner when its fiber is interrupted", () =>
  Effect.gen(function* () {
    diffCalls = 0
    summaryWrites = 0
    pauseSecondDiff = false
    pauseFirstRead = false
    messageReads = 0
    updatedMessages = new Set()
    messages = [user(userA), assistant("msg_summary_assistant_a", userA)]
    firstDiffStarted = yield* Deferred.make<void>()
    releaseFirstDiff = yield* Deferred.make<void>()

    const summary = yield* SessionSummary.Service
    const canceled = yield* summary.summarize({ sessionID, messageID: userA }).pipe(Effect.forkChild)
    yield* Deferred.await(firstDiffStarted)
    yield* Fiber.interrupt(canceled)
    yield* summary.summarize({ sessionID, messageID: userA })

    expect(diffCalls).toBe(3)
    expect(summaryWrites).toBe(1)
    expect(updatedMessages.has(userA)).toBe(true)
  }),
)

it.instance("prevents a disposed workspace runner from committing", () =>
  Effect.gen(function* () {
    diffCalls = 0
    summaryWrites = 0
    messageReads = 0
    pauseFirstRead = false
    pauseSecondDiff = false
    updatedMessages = new Set()
    messages = [user(userA), assistant("msg_summary_assistant_a", userA)]
    firstDiffStarted = yield* Deferred.make<void>()
    releaseFirstDiff = yield* Deferred.make<void>()

    const summary = yield* SessionSummary.Service
    const instance = yield* TestInstance
    const first = yield* summary.summarize({ sessionID, messageID: userA }).pipe(Effect.forkChild)
    yield* Deferred.await(firstDiffStarted)
    yield* Effect.promise(() => disposeInstance(instance.directory))
    yield* Deferred.succeed(releaseFirstDiff, undefined)
    yield* Fiber.join(first)

    expect(summaryWrites).toBe(0)
    expect(updatedMessages.size).toBe(0)
  }),
)
