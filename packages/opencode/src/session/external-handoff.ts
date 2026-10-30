import type { MessageV2 } from "./message-v2"
import type { Advisor } from "./external-schema"

export type ExternalConsultationHandoff = {
  version: 1
  advisor: Advisor
  task_id: string
  user_intervened: boolean
  user_turns: number
  read_before_summary: boolean
  delivery: "reference" | "inline_fallback"
  summary: { original_request: string; initial_answer: string; latest_request: string; latest_answer: string }
  read_transcript: { tool: "task_transcript"; arguments: { task_id: string; include: ["text"]; limit: 20 } }
}

const messageText = (message: MessageV2.WithParts | undefined) =>
  message?.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text.trim())
    .filter(Boolean) ?? []

const preview = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}\n[preview truncated]` : text

export function externalConversationOutput(input: {
  advisor: Advisor
  sessionID: string
  messages: readonly MessageV2.WithParts[]
  output: string
  userIntervened?: boolean
  transcriptAvailable?: boolean
}) {
  const turns = input.messages.filter((message) => message.info.role === "user").length
  const userIntervened = input.userIntervened === true || turns > 1
  const transcriptAvailable = input.transcriptAvailable !== false
  const header = input.output.match(/^<\w+_consult>[\s\S]*?<\/\w+_consult>/)?.[0]
  const body = header ? input.output.slice(header.length).trim() : input.output
  const firstQuestion = input.messages.find((message) => message.info.role === "user")
  const firstAnswer = input.messages.find((message) => message.info.role === "assistant")
  const lastAnswer = input.messages.findLast((message) => message.info.role === "assistant")
  const lastQuestion = input.messages.findLast((message) => message.info.role === "user")
  const handoff: ExternalConsultationHandoff = {
    version: 1,
    advisor: input.advisor,
    task_id: input.sessionID,
    user_intervened: userIntervened,
    user_turns: turns,
    read_before_summary: userIntervened && transcriptAvailable,
    delivery: transcriptAvailable ? "reference" : "inline_fallback",
    summary: {
      original_request: preview(messageText(firstQuestion).join("\n\n"), 400),
      initial_answer: preview(messageText(firstAnswer).at(-1) ?? "", 800),
      latest_request: preview(messageText(lastQuestion).join("\n\n"), 400),
      latest_answer: preview(messageText(lastAnswer).at(-1) ?? body, 400),
    },
    read_transcript: {
      tool: "task_transcript",
      arguments: { task_id: input.sessionID, include: ["text"], limit: 20 },
    },
  }
  const guide = handoff.read_before_summary
    ? "User intervention occurred. Before summarizing this consultation, MUST call task_transcript with read_transcript.arguments. Follow next_cursor to older pages until the original request and relevant earlier answers have been inspected. Summary fields are previews, not the full conversation. Never treat the last reply alone as the original task's result. Do not rerun the consultation or resume this external session with task."
    : transcriptAvailable
      ? "Use task_transcript with read_transcript.arguments when you need details or earlier context. task_id is the OpenCode child session, not the CLI thread/session id. Reading does not restart the advisor."
      : "task_transcript is unavailable for this turn. Use the inline conversation below; do not bypass tool restrictions or rerun the consultation to recover its history."
  let inline = ""
  if (userIntervened && !transcriptAvailable) {
    let turn = 0
    inline = input.messages
      .flatMap((message) => {
        if (message.info.role === "user") turn++
        const text = messageText(message).join("\n\n")
        return text ? [`### ${message.info.role === "user" ? "User" : input.advisor} - Turn ${turn}\n\n${text}`] : []
      })
      .join("\n\n")
    inline = `<consultation_history>\n${inline}\n</consultation_history>`
  } else if (!userIntervened) {
    inline = body
  }
  return {
    turns,
    handoff,
    output: [
      header,
      `<external_consultation>\n${JSON.stringify(handoff, null, 2)}\n</external_consultation>`,
      guide,
      inline,
    ]
      .filter(Boolean)
      .join("\n\n"),
  }
}
