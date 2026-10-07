import type { Prompt } from "./prompt"

export function createEmptyPrompt(): Prompt {
  return [{ type: "text", content: "", start: 0, end: 0 }]
}

// Templates are never live drafts, even when a caller accidentally uses a shallow copy.
export const DEFAULT_PROMPT: Prompt = createEmptyPrompt()
Object.freeze(DEFAULT_PROMPT[0])
Object.freeze(DEFAULT_PROMPT)
