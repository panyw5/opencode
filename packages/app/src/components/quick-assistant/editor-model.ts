import type { Prompt } from "@/context/prompt"
import { serialize } from "../prompt-input/editor-dom"
import { clonePromptParts } from "../prompt-input/history"

export function emptyQuickPrompt(): Prompt {
  return [{ type: "text", content: "", start: 0, end: 0 }]
}

export function quickPromptCanSend(input: { prompt: Prompt; loading: boolean; busy: boolean; ready: boolean }) {
  return (
    input.ready &&
    !input.loading &&
    !input.busy &&
    (!!quickPromptText(input.prompt).trim() || input.prompt.some((part) => part.type === "image"))
  )
}

export function recoverQuickPrompt(current: Prompt, submitted: Prompt): Prompt | undefined {
  if (quickPromptText(current) || current.some((part) => part.type === "image")) return
  return clonePromptParts(submitted)
}

export function quickPromptText(prompt: Prompt) {
  return prompt.map((part) => ("content" in part ? part.content : "")).join("")
}

export function parseQuickEditor(editor: HTMLElement): Prompt {
  const parts: Prompt = []
  let position = 0
  const visit = (node: Node) => {
    const el = node instanceof HTMLElement ? node : undefined
    const content = serialize(node)
    if (el?.dataset.type === "file" || el?.dataset.type === "agent" || el?.dataset.type === "im") {
      const base = { content, start: position, end: position + content.length }
      parts.push(
        el.dataset.type === "file"
          ? { ...base, type: "file", path: el.dataset.path! }
          : el.dataset.type === "agent"
            ? { ...base, type: "agent", name: el.dataset.name! }
            : { ...base, type: "im", channelName: el.dataset.channelName, botName: el.dataset.botName },
      )
      position += content.length
      return
    }
    if (node.nodeType === Node.TEXT_NODE || el?.tagName === "BR") {
      parts.push({ type: "text", content, start: position, end: position + content.length })
      position += content.length
      return
    }
    Array.from(node.childNodes).forEach((child, index, children) => {
      visit(child)
      if (child instanceof HTMLElement && ["DIV", "P"].includes(child.tagName) && index < children.length - 1) {
        parts.push({ type: "text", content: "\n", start: position, end: position + 1 })
        position += 1
      }
    })
  }
  visit(editor)
  return parts.length ? parts : [{ type: "text", content: "", start: 0, end: 0 }]
}
