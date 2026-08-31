import { Deferred, Effect, Layer, Schema, Context, Option as EffectOption } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { SessionID, MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionStatus } from "@/session/status"
import * as Log from "@opencode-ai/core/util/log"
import { QuestionID } from "./schema"
import { ScheduledTaskUnattended } from "@/scheduled-task/unattended"

const log = Log.create({ service: "question" })

// Schemas — these are pure data; nothing checks class identity (see PR
// description) so they're plain `Schema.Struct` + type alias. That lets
// `Question.ask` and other internal sites trust the type contract without a
// re-decode to coerce nested class instances.

export const Option = Schema.Struct({
  label: Schema.String.annotate({
    description: "Display text (1-5 words, concise)",
  }),
  description: Schema.String.annotate({
    description: "Explanation of choice",
  }),
}).annotate({ identifier: "QuestionOption" })
export type Option = Schema.Schema.Type<typeof Option>

const base = {
  question: Schema.String.annotate({
    description: "Complete question",
  }),
  header: Schema.String.annotate({
    description: "Very short label (max 30 chars)",
  }),
  options: Schema.Array(Option).annotate({
    description: "Available choices",
  }),
  multiple: Schema.optional(Schema.Boolean).annotate({
    description: "Allow selecting multiple choices",
  }),
}

export const Prompt = Schema.Struct(base).annotate({ identifier: "QuestionPrompt" })
export type Prompt = Schema.Schema.Type<typeof Prompt>

export const Info = Prompt
export type Info = Prompt

export const Image = Schema.Struct({
  type: Schema.Literal("image"),
  mime: Schema.String,
  url: Schema.String,
  filename: Schema.optional(Schema.String),
}).annotate({ identifier: "QuestionImageAnswer" })
export type Image = Schema.Schema.Type<typeof Image>

export const Part = Schema.Union([Schema.String, Image]).annotate({ identifier: "QuestionAnswerPart" })
export type Part = Schema.Schema.Type<typeof Part>

export const Tool = Schema.Struct({
  messageID: MessageID,
  callID: Schema.String,
}).annotate({ identifier: "QuestionTool" })
export type Tool = Schema.Schema.Type<typeof Tool>

export const Request = Schema.Struct({
  id: QuestionID,
  sessionID: SessionID,
  questions: Schema.Array(Info).annotate({
    description: "Questions to ask",
  }),
  tool: Schema.optional(Tool),
}).annotate({ identifier: "QuestionRequest" })
export type Request = Schema.Schema.Type<typeof Request>
const isRequest = Schema.is(Request)

export const Answer = Schema.Array(Part).annotate({ identifier: "QuestionAnswer" })
export type Answer = Schema.Schema.Type<typeof Answer>

export const Reply = Schema.Struct({
  answers: Schema.Array(Answer).annotate({
    description: "User answers in order of questions (each answer is an array of selected labels)",
  }),
}).annotate({ identifier: "QuestionReply" })
export type Reply = Schema.Schema.Type<typeof Reply>

const Replied = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
  answers: Schema.Array(Answer),
}).annotate({ identifier: "QuestionReplied" })

const Rejected = Schema.Struct({
  sessionID: SessionID,
  requestID: QuestionID,
}).annotate({ identifier: "QuestionRejected" })

export const Event = {
  Asked: BusEvent.define("question.asked", Request),
  Replied: BusEvent.define("question.replied", Replied),
  Rejected: BusEvent.define("question.rejected", Rejected),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
  phase: "registering" | "active"
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

const QUESTION_REQUEST_METADATA = "questionRequest"
const RECOVERED_SESSION_ENDED_MESSAGE =
  "Session has ended. Your answer was saved, but the original assistant run is no longer active. Send a new message to continue."
/** Startup / recovery: only scan the N most recently updated sessions (list is ordered by time_updated desc). */
const RECOVERY_SESSION_LIMIT = 50

type QuestionToolPart = {
  request: Request
  part: MessageV2.ToolPart
}

const cloneAnswers = (answers: ReadonlyArray<Answer>) =>
  answers.map((answer) => answer.map((part) => (typeof part === "string" ? part : { ...part })))

const formatAnswerPart = (part: Part) => {
  if (typeof part === "string") return part
  return part.filename ? `[image: ${part.filename}]` : "[image]"
}

function extractBase64(url: string): string {
  const comma = url.indexOf(",")
  if (comma === -1) return url
  const body = url.slice(comma + 1)
  if (!body.startsWith("data:")) return body
  return extractBase64(body)
}

function dataUrl(url: string, mime: string) {
  if (!url.startsWith("data:")) return `data:${mime};base64,${url}`
  return `data:${mime};base64,${extractBase64(url)}`
}

function answerFile(part: Part, sessionID: SessionID, messageID: MessageID): MessageV2.FilePart | undefined {
  if (typeof part === "string") return undefined
  return {
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "file",
    mime: part.mime,
    url: dataUrl(part.url, part.mime),
    filename: part.filename,
  }
}

const formatAnsweredOutput = (request: Request, answers: ReadonlyArray<Answer>) => {
  const formatted = request.questions
    .map(
      (q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].map(formatAnswerPart).join(", ") : "Unanswered"}"`,
    )
    .join(", ")

  return {
    title: `Session ended after ${request.questions.length} question${request.questions.length > 1 ? "s" : ""}`,
    output: `User has answered your questions: ${formatted}. ${RECOVERED_SESSION_ENDED_MESSAGE}`,
  }
}

const stateMetadata = (part: MessageV2.ToolPart): Record<string, any> =>
  part.state.status === "running" || part.state.status === "completed" || part.state.status === "error"
    ? (part.state.metadata ?? {})
    : {}

const requestFromPart = (part: MessageV2.Part): QuestionToolPart | undefined => {
  if (part.type !== "tool") return
  if (part.state.status !== "running" && part.state.status !== "pending") return
  const raw = stateMetadata(part)[QUESTION_REQUEST_METADATA]
  if (!isRequest(raw)) return
  return { request: raw, part }
}

const withoutQuestionRequest = (metadata: Record<string, any>) => {
  const next = { ...metadata }
  delete next[QUESTION_REQUEST_METADATA]
  return next
}

const waitForToolPart = Effect.fn("Question.waitForToolPart")(function* (
  request: Request,
  find: (request: Request) => Effect.Effect<MessageV2.ToolPart | undefined>,
  shouldContinue: (requestID: QuestionID) => Effect.Effect<boolean>,
) {
  const deadline = Date.now() + 500
  for (;;) {
    const part = yield* find(request)
    if (part || Date.now() >= deadline) return part
    if (!(yield* shouldContinue(request.id))) return undefined
    yield* Effect.sleep("20 millis")
  }
})

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly expireSuperseded: (input: {
    sessionID: SessionID
  }) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const findToolPart = Effect.fn("Question.findToolPart")(function* (request: Request) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session || !request.tool) return
      return yield* Effect.gen(function* () {
        const messages = yield* session.messages({ sessionID: request.sessionID })
        for (const message of messages) {
          if (message.info.id !== request.tool?.messageID) continue
          for (const part of message.parts) {
            if (
              part.type === "tool" &&
              part.messageID === request.tool.messageID &&
              part.callID === request.tool.callID &&
              (part.state.status === "running" || part.state.status === "pending")
            ) {
              return part
            }
          }
        }
        return undefined
      }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    })

    const isPending = Effect.fn("Question.isPending")(function* (requestID: QuestionID) {
      return (yield* InstanceState.get(state)).pending.has(requestID)
    })

    const persistRequest = Effect.fn("Question.persistRequest")(function* (input: {
      request: Request
      waitForPart: boolean
    }) {
      return yield* Effect.gen(function* () {
        const { request } = input
        const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
        if (!session) return false
        const part = input.waitForPart
          ? yield* waitForToolPart(request, findToolPart, isPending)
          : yield* findToolPart(request)
        if (!part) {
          if (request.tool && input.waitForPart && (yield* isPending(request.id))) {
            log.warn("failed to persist question request", {
              requestID: request.id,
              sessionID: request.sessionID,
              messageID: request.tool.messageID,
              callID: request.tool.callID,
            })
          }
          return false
        }
        if (!(yield* isPending(request.id))) return false

        const metadata = {
          ...stateMetadata(part),
          [QUESTION_REQUEST_METADATA]: request,
        }
        const partInput = part.state.input ?? { questions: request.questions }
        const next: MessageV2.ToolPart =
          part.state.status === "running"
            ? {
                ...part,
                state: {
                  ...part.state,
                  input: partInput,
                  metadata,
                },
              }
            : {
                ...part,
                state: {
                  status: "running",
                  input: partInput,
                  metadata,
                  time: { start: Date.now() },
                },
              }
        yield* session.updatePart(next)
        if (yield* isPending(request.id)) return true
        const latest = yield* findToolPart(request)
        if (latest?.state.status === "running") {
          yield* session.updatePart({
            ...latest,
            state: {
              ...latest.state,
              metadata: withoutQuestionRequest(latest.state.metadata ?? {}),
            },
          })
        }
        return false
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.warn("question request persist failed", { cause })
            return false
          }),
        ),
      )
    })

    const clearPersistedRequest = Effect.fn("Question.clearPersistedRequest")(function* (request: Request) {
      yield* Effect.gen(function* () {
        const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
        if (!session) return
        const part = yield* findToolPart(request)
        if (!part || part.state.status !== "running") return
        yield* session.updatePart({
          ...part,
          state: {
            ...part.state,
            metadata: withoutQuestionRequest(part.state.metadata ?? {}),
          },
        })
      }).pipe(Effect.catchCause((cause) => Effect.sync(() => log.warn("question request clear failed", { cause }))))
    })

    /** Pure: pull active question tool parts out of already-loaded messages. */
    const collectFromMessages = (messages: MessageV2.WithParts[]) => {
      const result: QuestionToolPart[] = []
      for (const message of messages) {
        for (const part of message.parts) {
          const item = requestFromPart(part)
          if (item) result.push(item)
        }
      }
      return result
    }

    /**
     * Load one session's messages and collect active persisted questions.
     * Shared by session-scoped and workspace-scoped scanners.
     */
    const scanSessionPersisted = Effect.fn("Question.scanSessionPersisted")(function* (sessionID: SessionID) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return [] as QuestionToolPart[]
      const messages = yield* session
        .messages({ sessionID })
        .pipe(Effect.catchCause(() => Effect.succeed([] as MessageV2.WithParts[])))
      return collectFromMessages(messages)
    })

    /**
     * New-message / per-turn path: only the current session.
     * Used by expireSuperseded so sending a prompt does not scan the whole workspace.
     */
    const persistedInSession = Effect.fn("Question.persistedInSession")(function* (sessionID: SessionID) {
      return yield* scanSessionPersisted(sessionID)
    })

    /**
     * Startup / recovery path: scan the most recently updated sessions (default 50).
     * Session.list is ordered by time_updated desc.
     * Used by list() (frontend bootstrap rehydrate).
     */
    const persistedAll = Effect.fn("Question.persistedAll")(function* (opts?: { limit?: number }) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return [] as QuestionToolPart[]
      const limit = opts?.limit ?? RECOVERY_SESSION_LIMIT
      const sessions = yield* session.list({ limit })
      const result: QuestionToolPart[] = []
      for (const item of sessions) {
        for (const q of yield* scanSessionPersisted(item.id)) result.push(q)
      }
      return result
    })

    /**
     * Find one persisted question by id (restart recovery for reply/reject).
     * Walks recent sessions until match so we can early-exit.
     */
    const findPersisted = Effect.fn("Question.findPersisted")(function* (requestID: QuestionID) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return undefined

      const sessions = yield* session.list({ limit: RECOVERY_SESSION_LIMIT })
      for (const item of sessions) {
        const match = (yield* scanSessionPersisted(item.id)).find((q) => q.request.id === requestID)
        if (match) return match
      }
      return undefined
    })

    const completePersisted = Effect.fn("Question.completePersisted")(function* (
      item: QuestionToolPart,
      answers: ReadonlyArray<Answer>,
    ) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return
      const now = Date.now()
      const input = item.part.state.input ?? { questions: item.request.questions }
      const time =
        item.part.state.status === "running"
          ? { start: item.part.state.time.start, end: now }
          : { start: now, end: now }
      const output = formatAnsweredOutput(item.request, answers)
      const attachments = answers.flatMap((answer) =>
        answer.flatMap((part) => {
          const next = answerFile(part, item.part.sessionID, item.part.messageID)
          return next ? [next] : []
        }),
      )
      yield* session.updatePart({
        ...item.part,
        state: {
          status: "completed",
          input,
          title: output.title,
          output: output.output,
          metadata: {
            ...withoutQuestionRequest(stateMetadata(item.part)),
            answers: cloneAnswers(answers),
            sessionEnded: true,
          },
          time,
          attachments: attachments.length ? attachments : undefined,
        },
      })
    })

    const finalizeRecoveredAssistant = Effect.fn("Question.finalizeRecoveredAssistant")(function* (
      item: QuestionToolPart,
    ) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return false
      const status = EffectOption.getOrUndefined(yield* Effect.serviceOption(SessionStatus.Service))
      const match = yield* session
        .findMessage(item.part.sessionID, (message) => message.info.id === item.part.messageID)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(EffectOption.none<MessageV2.WithParts>())))
      const message = EffectOption.getOrUndefined(match)
      if (!message) {
        log.warn("recovered question owner message not found", {
          requestID: item.request.id,
          sessionID: item.part.sessionID,
          messageID: item.part.messageID,
        })
        return false
      }
      if (message.info.role !== "assistant") return false
      if (typeof message.info.time.completed === "number") return false

      const now = Date.now()
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        if (part.id === item.part.id) continue
        if (part.state.status !== "running" && part.state.status !== "pending") continue
        const metadata = part.state.status === "running" ? part.state.metadata : undefined
        yield* session.updatePart({
          ...part,
          state: {
            status: "error",
            input: part.state.input,
            error: "Tool execution aborted because the session ended",
            ...(metadata ? { metadata } : {}),
            time: {
              start: part.state.status === "running" ? part.state.time.start : now,
              end: now,
            },
          },
        })
      }

      yield* session.updateMessage({
        ...message.info,
        error:
          message.info.error ??
          MessageV2.fromError(new DOMException(RECOVERED_SESSION_ENDED_MESSAGE, "AbortError"), {
            providerID: message.info.providerID,
            aborted: true,
          }),
        time: {
          ...message.info.time,
          completed: now,
        },
      })
      if (status) yield* status.set(item.part.sessionID, { type: "idle" })
      return true
    })

    const rejectPersisted = Effect.fn("Question.rejectPersisted")(function* (item: QuestionToolPart) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return
      const now = Date.now()
      const input = item.part.state.input ?? { questions: item.request.questions }
      const time =
        item.part.state.status === "running"
          ? { start: item.part.state.time.start, end: now }
          : { start: now, end: now }
      yield* session.updatePart({
        ...item.part,
        state: {
          status: "error",
          input,
          error: new RejectedError().message,
          metadata: withoutQuestionRequest(stateMetadata(item.part)),
          time,
        },
      })
    })

    const isSuperseded = Effect.fn("Question.isSuperseded")(function* (request: Request) {
      if (!request.tool) return false
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return false
      const messages = yield* session
        .messages({ sessionID: request.sessionID })
        .pipe(Effect.catchCause(() => Effect.succeed([])))
      const index = messages.findIndex((m) => m.info.id === request.tool!.messageID)
      if (index === -1) return false
      return index < messages.length - 1
    })

    const findPersistedQuestionPart = Effect.fn("Question.findPersistedQuestionPart")(function* (
      request: Request,
    ) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session || !request.tool) return
      const messages = yield* session
        .messages({ sessionID: request.sessionID })
        .pipe(Effect.catchCause(() => Effect.succeed([])))
      for (const message of messages) {
        if (message.info.id !== request.tool.messageID) continue
        for (const part of message.parts) {
          if (part.type !== "tool") continue
          if (part.messageID !== request.tool.messageID || part.callID !== request.tool.callID) continue
          const metadata =
            part.state.status === "running" || part.state.status === "completed" || part.state.status === "error"
              ? (part.state.metadata ?? {})
              : {}
          if (!isRequest(metadata[QUESTION_REQUEST_METADATA])) continue
          return part
        }
      }
      return undefined
    })

    const clearQuestionMetadata = Effect.fn("Question.clearQuestionMetadata")(function* (part: MessageV2.ToolPart) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return
      const metadata =
        part.state.status === "running" || part.state.status === "completed" || part.state.status === "error"
          ? (part.state.metadata ?? {})
          : {}
      if (!metadata[QUESTION_REQUEST_METADATA]) return
      yield* session.updatePart({
        ...part,
        state: {
          ...part.state,
          metadata: withoutQuestionRequest(metadata),
        },
      })
    })

    const finalizeQuestionAssistant = Effect.fn("Question.finalizeQuestionAssistant")(function* (
      request: Request,
    ) {
      const session = EffectOption.getOrUndefined(yield* Effect.serviceOption(Session.Service))
      if (!session) return
      const status = EffectOption.getOrUndefined(yield* Effect.serviceOption(SessionStatus.Service))
      const match = yield* session
        .findMessage(request.sessionID, (m) => m.info.id === request.tool!.messageID)
        .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(EffectOption.none<MessageV2.WithParts>())))
      const message = EffectOption.getOrUndefined(match)
      if (!message || message.info.role !== "assistant") return
      if (typeof message.info.time.completed === "number") return
      const now = Date.now()
      yield* session.updateMessage({
        ...message.info,
        error:
          message.info.error ??
          MessageV2.fromError(new DOMException("Question superseded by a later message", "AbortError"), {
            providerID: message.info.providerID,
            aborted: true,
          }),
        time: { ...message.info.time, completed: now },
      })
      if (status) yield* status.set(request.sessionID, { type: "idle" })
    })

    const expireSuperseded = Effect.fn("Question.expireSuperseded")(function* (input: { sessionID: SessionID }) {
      const pending = (yield* InstanceState.get(state)).pending
      let count = 0

      // Phase 1: In-memory pending requests for this session
      const expiredIDs: QuestionID[] = []
      for (const [id, entry] of pending) {
        if (entry.info.sessionID !== input.sessionID) continue
        if (entry.phase === "registering") continue
        if (!(yield* isSuperseded(entry.info))) continue
        expiredIDs.push(id)
      }

      for (const id of expiredIDs) {
        const entry = pending.get(id)
        if (!entry) continue
        pending.delete(id)
        yield* clearPersistedRequest(entry.info)
        yield* bus.publish(Event.Rejected, {
          sessionID: entry.info.sessionID,
          requestID: entry.info.id,
        })
        yield* Deferred.fail(entry.deferred, new RejectedError())
        count++
      }

      // Phase 2: persisted questions for this session only (new-message path).
      // Workspace recovery for bootstrap lives in list()/findPersisted via persistedAll.
      for (const item of yield* persistedInSession(input.sessionID)) {
        if (pending.get(item.request.id)?.phase === "registering") continue
        if (!(yield* isSuperseded(item.request))) continue

        // Clear metadata (handles any tool part status)
        const part = yield* findPersistedQuestionPart(item.request)
        if (part) yield* clearQuestionMetadata(part)

        // If still running, transition to terminal error state
        if (item.part.state.status === "running" || item.part.state.status === "pending") {
          yield* rejectPersisted(item)
        }

        // Finalize owning assistant if incomplete
        yield* finalizeQuestionAssistant(item.request)

        yield* bus.publish(Event.Rejected, {
          sessionID: item.request.sessionID,
          requestID: item.request.id,
        })
        count++
      }

      log.info("expired superseded questions", { sessionID: input.sessionID, count })
      return count
    })

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      if (yield* ScheduledTaskUnattended.ContextRef) return yield* new RejectedError()
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      log.info("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      const entry: PendingEntry = { info, deferred, phase: "registering" }
      pending.set(id, entry)
      const persisted = yield* persistRequest({ request: info, waitForPart: false })
      const supersededAtRegistration = yield* isSuperseded(info)
      log.info("question registered", {
        id,
        sessionID: input.sessionID,
        messageID: input.tool?.messageID,
        persisted,
        supersededAtRegistration,
      })
      if (supersededAtRegistration) {
        if (pending.get(id) === entry) pending.delete(id)
        yield* clearPersistedRequest(info)
        log.info("rejecting question superseded before registration", {
          id,
          sessionID: input.sessionID,
          messageID: input.tool?.messageID,
        })
        return yield* new RejectedError()
      }
      yield* bus.publish(Event.Asked, info)
      if (pending.get(id) === entry) {
        entry.phase = "active"
        // Close the narrow window where a newer message is written after the
        // registration check but before Asked is published. Active entries are
        // rejected through the normal event path, preserving Asked -> Rejected.
        yield* expireSuperseded({ sessionID: input.sessionID })
      }
      if (!persisted && info.tool) yield* persistRequest({ request: info, waitForPart: true })

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) {
        const recovered = yield* findPersisted(input.requestID)
        if (!recovered) {
          log.warn("reply for unknown request", { requestID: input.requestID })
          return yield* new NotFoundError({ requestID: input.requestID })
        }
        yield* completePersisted(recovered, input.answers)
        const finalized = yield* finalizeRecoveredAssistant(recovered)
        log.info("replied recovered question", {
          requestID: input.requestID,
          answers: input.answers,
          finalizedAssistant: finalized,
        })
        yield* bus.publish(Event.Replied, {
          sessionID: recovered.request.sessionID,
          requestID: recovered.request.id,
          answers: cloneAnswers(input.answers),
        })
        return
      }
      pending.delete(input.requestID)
      yield* clearPersistedRequest(existing.info)
      log.info("replied", { requestID: input.requestID, answers: input.answers })
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: cloneAnswers(input.answers),
      })
      yield* Deferred.succeed(existing.deferred, input.answers)
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) {
        const recovered = yield* findPersisted(requestID)
        if (!recovered) {
          log.warn("reject for unknown request", { requestID })
          return yield* new NotFoundError({ requestID })
        }
        yield* rejectPersisted(recovered)
        yield* finalizeRecoveredAssistant(recovered)
        log.info("rejected recovered question", { requestID })
        yield* bus.publish(Event.Rejected, {
          sessionID: recovered.request.sessionID,
          requestID: recovered.request.id,
        })
        return
      }
      pending.delete(requestID)
      yield* clearPersistedRequest(existing.info)
      log.info("rejected", { requestID })
      yield* bus.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    /**
     * Startup / bootstrap path: in-memory pending + recent-session persisted recovery.
     * Frontend calls this on connect to rehydrate docks after app restart.
     */
    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      const entries = Array.from(pending.values())
      const result = entries.filter((item) => item.phase === "active").map((item) => item.info)
      const seen = new Set(entries.map((item) => item.info.id))
      for (const item of yield* persistedAll()) {
        if (seen.has(item.request.id)) continue
        seen.add(item.request.id)
        result.push(item.request)
      }
      return result
    })

    return Service.of({ ask, reply, reject, list, expireSuperseded })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Question from "."
