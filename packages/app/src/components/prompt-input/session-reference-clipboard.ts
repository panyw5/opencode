import { readSessionReference } from "@opencode-ai/ui/session-reference"
import type { SessionContextItem, SessionPart } from "@/context/prompt"

const PREFIX = "opencode://session-reference/v1#"
const MAX_LENGTH = 128 * 1024

export function sessionReferenceClipboard(reference: SessionContextItem) {
  return PREFIX + encodeURIComponent(JSON.stringify(reference))
}

export function readSessionReferenceClipboard(text: string): SessionContextItem | undefined {
  const value = text.trim()
  if (!value.startsWith(PREFIX) || value.length > MAX_LENGTH) return
  try {
    return readSessionReference({ sessionReference: JSON.parse(decodeURIComponent(value.slice(PREFIX.length))) })
  } catch {
    console.debug("[session-reference-clipboard] invalid reference ignored")
  }
}

export function sessionReferencePart(reference: SessionContextItem): SessionPart {
  const content = `@${reference.title || reference.sessionID}`
  return { type: "session", reference, content, start: 0, end: content.length }
}
