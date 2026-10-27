import * as Tool from "./tool"
import DESCRIPTION from "./session_transcript.txt"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Effect, Schema } from "effect"
import * as EffectLogger from "@opencode-ai/core/effect/logger"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_FIELD_CHARS = 4_000

const log = EffectLogger.create({ service: "tool.session_transcript" })

export const Parameters = Schema.Struct({
  session_id: SessionID.annotate({
    description: "The id of any session to read (root or child, any directory)",
  }),
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

// These renderers intentionally mirror `task_transcript` so both transcripts read
// the same way. They are kept local here so `task_transcript` stays untouched.
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

export const SessionTranscriptTool = Tool.define(
  "session_transcript",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    const run = Effect.fn("SessionTranscriptTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      yield* log.info("session transcript read started", {
        readerSessionID: ctx.sessionID,
        targetSessionID: params.session_id,
      })

      // Any session id is allowed here, unlike `task_transcript` which is
      // restricted to descendants of the current session.
      const session = yield* sessions.get(params.session_id)
      const page = yield* MessageV2.page({
        sessionID: params.session_id,
        limit: params.limit ?? DEFAULT_LIMIT,
        before: params.cursor,
      })
      const include = new Set(params.include ?? ["text", "tool"])
      const content = page.items.map((message) => renderMessage(message, include)).join("\n\n") || "No messages in this page."
      const cursor = page.cursor ? `next_cursor: ${page.cursor}\n` : ""

      yield* log.info("session transcript read completed", {
        readerSessionID: ctx.sessionID,
        targetSessionID: params.session_id,
        messages: page.items.length,
        more: page.more,
      })

      return {
        title: "Session transcript",
        metadata: {
          session_id: params.session_id,
          parent_task_id: session.parentID,
          directory: session.directory,
          next_cursor: page.cursor,
          more: page.more,
        },
        output: [
          `session_id: ${params.session_id}`,
          `title: ${session.title}`,
          `directory: ${session.directory}`,
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
