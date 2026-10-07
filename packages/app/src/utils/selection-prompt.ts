import type { Prompt } from "@/context/prompt"

export const QUICK_ASSISTANT_SELECTION_EVENT = "opencode:quick-assistant-selection"

export function appendSelectionToPrompt(prompt: Prompt, text: string): { prompt: Prompt; cursor: number } {
  const cursor = prompt.reduce((length, part) => length + ("content" in part ? part.content.length : 0), 0)
  const content = `${cursor ? "\n\n" : ""}${text}`
  return {
    prompt: [...prompt, { type: "text", content, start: cursor, end: cursor + content.length }],
    cursor: cursor + content.length,
  }
}
