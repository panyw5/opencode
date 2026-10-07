import type { FileContent } from "@opencode-ai/sdk/v2"

export type FileSelection = {
  startLine: number
  startChar: number
  endLine: number
  endChar: number
}

export type SelectedLineRange = {
  start: number
  end: number
  side?: "additions" | "deletions"
  endSide?: "additions" | "deletions"
}

export type FileViewState = {
  scrollTop?: number
  scrollLeft?: number
  selectedLines?: SelectedLineRange | null
  /**
   * Bumped every time a non-null selection is stored for this file. Together
   * with `settledSeq` it expresses "a selection jump is pending": while
   * `selectionSeq > settledSeq`, the viewport belongs to the selection jump and
   * scroll restores must not touch it. This replaces time-based guards — the
   * precedence is derived from state, never from clocks.
   */
  selectionSeq?: number
  settledSeq?: number
}

export type FileState = {
  path: string
  name: string
  loaded?: boolean
  loading?: boolean
  error?: string
  content?: FileContent
}

export function selectionFromLines(range: SelectedLineRange): FileSelection {
  const startLine = Math.min(range.start, range.end)
  const endLine = Math.max(range.start, range.end)
  return {
    startLine,
    endLine,
    startChar: 0,
    endChar: 0,
  }
}
