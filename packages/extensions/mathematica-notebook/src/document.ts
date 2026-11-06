import type { Cell } from "./notebook"
import type { Output } from "./kernel"

export type ViewerCell = Pick<Cell, "index" | "style" | "text" | "editable" | "runnable">
export type ViewerDocument = {
  path: string
  revision: string
  cells: ViewerCell[]
  outputs: Record<number, Output>
}

export function viewerCells(cells: readonly Cell[]): ViewerCell[] {
  return cells.map(({ index, style, text, editable, runnable }) => ({ index, style, text, editable, runnable }))
}
