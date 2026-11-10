import { Effect, Semaphore } from "effect"
import type { AgentEvent } from "@/agent-backend/backend"
import type { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID } from "./schema"
import type { Session } from "./session"
import type { SessionStatus } from "./status"

export type TranscriptItem = AgentEvent

/**
 * Writes an external agent transcript into an OpenCode session as ordinary
 * user/assistant messages and parts. Used both by consult child sessions and by
 * session-level channels.
 */
export function makeTranscriptProjector(input: {
  sessions: Session.Interface
  statuses: SessionStatus.Interface
  session: Session.Info
  agent: string
  model: { providerID: ProviderID; modelID: ModelID }
  initialText: string
  initialMessageID?: MessageID
  /** Set false when the caller already wrote the user message for this turn. */
  writeInitialUser?: boolean
  /** `turns` starts a new user turn for transcript user items (consult); `ignore` keeps the caller's user turns. */
  userItems?: "turns" | "ignore"
  finalIdle?: boolean
}) {
  const { sessions, statuses, session, agent, model } = input
  const userItems = input.userItems ?? "turns"
  const finalIdle = input.finalIdle ?? true
  const lock = Semaphore.makeUnsafe(1)
  const pending = new Map<string, TranscriptItem>()
  const written = new Map<string, string>()
  const parts = new Map<string, { id: PartID; messageID: MessageID; start: number }>()
  const assistants: MessageV2.Assistant[] = []
  let userID: MessageID
  let assistant: MessageV2.Assistant
  let initialized = false
  let finalized = false

  const turn = (text: string, messageID?: MessageID, writeUser = true) =>
    Effect.gen(function* () {
      if (assistant) {
        assistant.time.completed = Date.now()
        yield* sessions.updateMessage(assistant)
      }
      userID = messageID ?? MessageID.ascending()
      if (writeUser) {
        yield* sessions.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          agent,
          model,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userID,
          type: "text",
          text,
        })
      }
      assistant = {
        id: MessageID.ascending(),
        sessionID: session.id,
        role: "assistant",
        parentID: userID,
        agent,
        mode: agent,
        ...model,
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      }
      assistants.push(assistant)
      yield* sessions.updateMessage(assistant)
    })

  const apply = (items: readonly TranscriptItem[], final = false, error?: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (finalized && !final) return
        if (!initialized) {
          yield* turn(input.initialText, input.initialMessageID, input.writeInitialUser !== false)
          initialized = true
        }
        for (const item of items) pending.set(item.id, { ...pending.get(item.id), ...item })
        for (const [key, item] of pending) {
          const signature = JSON.stringify([item, final])
          if (written.get(key) === signature) continue
          if (item.kind === "user") {
            if (userItems === "ignore" || written.has(key) || key === "user:initial") {
              written.set(key, signature)
              continue
            }
            yield* turn(item.text ?? "")
            written.set(key, signature)
            continue
          }
          const ref = parts.get(key) ?? { id: PartID.ascending(), messageID: assistant.id, start: Date.now() }
          parts.set(key, ref)
          const base = { id: ref.id, sessionID: session.id, messageID: ref.messageID }
          const time = {
            start: ref.start,
            ...(final || item.status === "completed" || item.status === "error" ? { end: Date.now() } : {}),
          }
          const completedText =
            item.kind === "status" &&
            item.title === "Turn completed" &&
            item.text?.trim() &&
            !/^in=\d+\s+out=\d+/.test(item.text.trim())
          const duplicateText =
            completedText &&
            [...pending.values()].some((other) => other.kind === "message" && other.text?.trim() === item.text?.trim())
          if (duplicateText) {
            written.set(key, signature)
            continue
          }
          if (item.kind === "message" || completedText) {
            yield* sessions.updatePart({
              ...base,
              type: "text",
              text: item.text ?? "",
              time,
              metadata: { externalEvent: key },
            })
          } else if (item.kind === "reasoning" || item.kind === "thinking") {
            yield* sessions.updatePart({ ...base, type: "reasoning", text: item.text ?? "", time })
          } else {
            // These are observed external events, never locally executable tools.
            const running = !final && (item.status === "running" || item.status === "pending")
            const metadata = { external: true, title: item.title ?? item.kind, status: item.status }
            yield* sessions.updatePart({
              ...base,
              type: "tool",
              callID: `external:${key}`,
              tool: `external_${item.kind}`,
              state: running
                ? {
                    status: "running",
                    input: {},
                    title: item.title ?? item.kind,
                    metadata: { ...metadata, output: item.text ?? "" },
                    time: { start: ref.start },
                  }
                : {
                    status: "completed",
                    input: {},
                    title: item.title ?? item.kind,
                    output: item.text ?? "",
                    metadata,
                    time: { start: ref.start, end: Date.now() },
                  },
            })
          }
          written.set(key, signature)
        }
        if (final) {
          finalized = true
          for (const msg of assistants) {
            msg.time.completed ??= Date.now()
            msg.finish = "stop"
            if (msg === assistant && error) msg.error = { name: "UnknownError", data: { message: error } }
            yield* sessions.updateMessage(msg)
          }
          if (finalIdle) yield* statuses.set(session.id, { type: "idle" })
        }
      }),
    )

  return { apply }
}

export * as TranscriptProjector from "./transcript-projector"
