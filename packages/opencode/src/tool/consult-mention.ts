/** Reserved @-mention names that route to external CLI consult tools (not task/subagent). */
export type ConsultMentionID = "codex" | "claude" | "grok" | "dsh"

export type ConsultMentionTool = "codex_consult" | "claude_consult" | "grok_consult" | "dsh_consult"

export const CONSULT_MENTION_IDS = ["codex", "claude", "grok", "dsh"] as const satisfies readonly ConsultMentionID[]

export const CONSULT_MENTIONS: Record<
  ConsultMentionID,
  { tool: ConsultMentionTool; label: string }
> = {
  codex: { tool: "codex_consult", label: "Codex" },
  claude: { tool: "claude_consult", label: "Claude" },
  grok: { tool: "grok_consult", label: "Grok" },
  dsh: { tool: "dsh_consult", label: "DeepSeek" },
}

export function isConsultMention(name: string): name is ConsultMentionID {
  return Object.hasOwn(CONSULT_MENTIONS, name)
}

export function isConsultTool(tool: string): tool is ConsultMentionTool {
  return (
    tool === "codex_consult" ||
    tool === "claude_consult" ||
    tool === "grok_consult" ||
    tool === "dsh_consult"
  )
}

export function consultMentionFor(name: string) {
  if (!isConsultMention(name)) return undefined
  return { id: name as ConsultMentionID, ...CONSULT_MENTIONS[name] }
}

/**
 * Build the consult CLI prompt from the user's current turn.
 * Prefer user text + @file paths; do not rely on the main agent to rephrase.
 */
export function buildConsultPromptFromParts(parts: readonly unknown[]): string {
  const texts: string[] = []
  const files: string[] = []

  for (const raw of parts) {
    const part = raw as {
      type?: string
      text?: string
      synthetic?: boolean
      ignored?: boolean
      filename?: string
      source?: { path?: string }
    }
    if (part.type === "text" && !part.synthetic && !part.ignored) {
      const text = part.text?.trim()
      if (text) texts.push(text)
    }
    if (part.type === "file") {
      const path = part.source?.path?.trim() || part.filename?.trim()
      if (path) files.push(path)
    }
  }

  const body = texts.join("\n\n").trim()
  if (files.length === 0) return body
  const fileBlock = ["Referenced files:", ...files.map((path) => `- ${path}`)].join("\n")
  return body ? `${body}\n\n${fileBlock}` : fileBlock
}

/** Synthetic note for the main agent after a direct consult finishes (optional follow-up turn). */
export function buildConsultFollowupSynthetic(names: string[]): string {
  const labels = names
    .map((name) => consultMentionFor(name)?.label ?? name)
    .filter(Boolean)
  const list = labels.length ? labels.join(", ") : "the external advisor"
  return [
    `The user invoked ${list} via @-mention.`,
    "The consultation tool result is already in this conversation.",
    "Summarize the advisor output for the user and continue only if further action is needed.",
    "Do not re-invoke the same consult tool unless the user asks for another consultation.",
  ].join(" ")
}
