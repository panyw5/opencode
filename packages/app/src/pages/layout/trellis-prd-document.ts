import { pair } from "@/components/dialog-prompt-editor-input"

export type PrdDocumentState = {
  savedContent: string
  draft: string
}

export function createPrdDocumentState(initialContent: string | undefined): PrdDocumentState {
  const content = initialContent ?? ""
  return {
    savedContent: content,
    draft: content,
  }
}

export function commitPrdDocumentSave(state: PrdDocumentState): PrdDocumentState {
  return {
    savedContent: state.draft,
    draft: state.draft,
  }
}

export function prdPreviewTitle(taskName: string) {
  return taskName.trim()
}

export function applyPrdDocumentPairEdit(input: {
  text: string
  start: number
  end: number
  key: string
}) {
  return pair(input)
}
