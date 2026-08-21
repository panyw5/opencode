import * as Tool from "./tool"
import DESCRIPTION from "./task_transcript.txt"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Effect, Schema } from "effect"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_FIELD_CHARS = 4_000

export const Parameters = Schema.Struct({
  task_id: SessionID.annotate({ description: "The task_id returned by task or discovered with task_list" }),
  cursor: Schema.optional(Schema.String).annotate({
    description: "Opaque next_cursor returned by a previous call, to read older messages",
  }),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_LIMIT)).annotate({
      description: `Messages to return (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT})`,
    }),
  ),
  include: Schema.optional(Schema.Array(Schema.Literals(["text", "tool", "reasoning"]))).annotate({
    description: "Content to include; defaults to text and tool. Reasoning is excluded unless explicitly requested.",
  }),
})

function clip(text: string) {
  if (text.length <= MAX_FIELD_CHARS) return text
  return `${text.slice(0, MAX_FIELD_CHARS)}\n[truncated ${text.length - MAX_FIELD_CHARS} chars]`
}

function stringify(value: unknown) {
  try {
    return clip(JSON.stringify(value) ?? String(value))
  } catch {
    return "[unserializable tool input]"
  }
}

function assistantError(error: NonNullable<MessageV2.Assistant["error"]>) {
  const data = Reflect.get(error, "data")
  const message = data && typeof data === "object" ? Reflect.get(data, "message") : undefined
  return typeof message === "string" && message ? message : error.name
}

function renderMessage(message: MessageV2.WithParts, include: Set<string>) {
  const lines = [
    `[${message.info.role}] message_id: ${message.info.id} created: ${message.info.time.created}`,
  ]
  if (message.info.role === "assistant") {
    if (message.info.finish) lines.push(`finish: ${message.info.finish}`)
    if (message.info.error) lines.push(`error: ${assistantError(message.info.error)}`)
  }

  for (const part of message.parts) {
    if (part.type === "text" && include.has("text")) {
      lines.push(`text:\n${clip(part.text)}`)
      continue
    }
    if (part.type === "reasoning" && include.has("reasoning")) {
      lines.push(`reasoning:\n${clip(part.text)}`)
      continue
    }
    if (part.type !== "tool" || !include.has("tool")) continue

    lines.push(`tool: ${part.tool} (${part.state.status})`)
    lines.push(`input: ${stringify(part.state.input)}`)
    if (part.state.status === "completed") lines.push(`output:\n${clip(part.state.output)}`)
    if (part.state.status === "error") lines.push(`error: ${clip(part.state.error)}`)
    if (part.state.status === "running" && part.state.title) lines.push(`title: ${clip(part.state.title)}`)
  }
  return lines.join("\n")
}

function isDescendant(sessions: Session.Interface, parentID: SessionID, taskID: SessionID) {
  return Effect.gen(function* () {
    let current = yield* sessions.get(taskID)
    const visited = new Set<string>()
    while (current.parentID) {
      if (current.parentID === parentID) return true
      if (visited.has(current.parentID)) return false
      visited.add(current.parentID)
      const next = yield* sessions.get(current.parentID).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!next) return false
      current = next
    }
    return false
  })
}

export const TaskTranscriptTool = Tool.define(
  "task_transcript",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTranscriptTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const allowed = yield* isDescendant(sessions, ctx.sessionID, params.task_id).pipe(
        Effect.catch(() => Effect.succeed(false)),
      )
      if (!allowed) return yield* Effect.fail(new Error("task_id must identify a child task of the current session"))

      const session = yield* sessions.get(params.task_id)
      const page = yield* MessageV2.page({
        sessionID: params.task_id,
        limit: params.limit ?? DEFAULT_LIMIT,
        before: params.cursor,
      })
      const include = new Set(params.include ?? ["text", "tool"])
      const content = page.items.map((message) => renderMessage(message, include)).join("\n\n") || "No messages in this page."
      const cursor = page.cursor ? `next_cursor: ${page.cursor}\n` : ""

      return {
        title: "Task transcript",
        metadata: {
          task_id: params.task_id,
          next_cursor: page.cursor,
          more: page.more,
        },
        output: [
          `task_id: ${params.task_id}`,
          `title: ${session.title}`,
          `messages: ${page.items.length}`,
          `more: ${page.more}`,
          cursor.trimEnd(),
          "",
          content,
        ]
          .filter(Boolean)
          .join("\n"),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
