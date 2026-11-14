export const PROMPT_CONTEXT_REQUEST_EVENT = "opencode:prompt-context-add"

// Dispatched by file viewers (e.g. extension viewers) that want to reference a
// file — optionally a line range — in the current session's prompt context.
export type PromptContextRequest = {
  directory?: string
  path: string
  selection?: { startLine: number; endLine: number }
  preview?: string
}

export function requestPromptContext(input: PromptContextRequest) {
  window.dispatchEvent(new CustomEvent<PromptContextRequest>(PROMPT_CONTEXT_REQUEST_EVENT, { detail: input }))
}
