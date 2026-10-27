import { readSessionReference } from "@opencode-ai/ui/session-reference"
import type { SessionPart } from "@/context/prompt"

export function createSessionPill(part: SessionPart) {
  const pill = document.createElement("span")
  pill.dataset.type = "session"
  pill.dataset.content = part.content
  pill.dataset.reference = JSON.stringify(part.reference)
  pill.className =
    "inline-flex max-w-full items-center gap-1 rounded-full border border-border-weak-base bg-surface-raised-base px-2 align-bottom text-syntax-property"
  pill.title = `${part.reference.title}\n${part.reference.directory}\n${part.reference.sessionID}`
  pill.setAttribute("contenteditable", "false")
  const label = document.createElement("span")
  label.className = "truncate"
  label.textContent = part.content
  pill.append(label)
  return pill
}

export function readSessionPill(pill: HTMLElement, start: number): SessionPart | undefined {
  try {
    const reference = readSessionReference({ sessionReference: JSON.parse(pill.dataset.reference ?? "null") })
    const content = pill.dataset.content
    if (!reference || !content) return
    return { type: "session", reference, content, start, end: start + content.length }
  } catch (error) {
    console.warn("[session-reference] invalid pill", { error })
  }
}
