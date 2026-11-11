export const PREVIEW_LIMITS = {
  depth: 64,
  nodes: 1200,
  dom: 2000,
  text: 8000,
  milliseconds: 100,
  cellBytes: 128 * 1024,
  batchBytes: 512 * 1024,
  batch: 8,
  inlineText: 8000,
  sourceChunk: 16_000,
} as const

export type Box = {
  kind:
    | "text"
    | "row"
    | "lines"
    | "frac"
    | "sup"
    | "sub"
    | "subsup"
    | "sqrt"
    | "root"
    | "over"
    | "under"
    | "underover"
    | "grid"
    | "style"
    | "unknown"
  text?: string
  children?: Box[]
  style?: { bold?: boolean; italic?: boolean; color?: string; size?: number }
}
export type Preview = {
  index: number
  status: "complete" | "partial" | "limited" | "unsupported"
  box: Box
  reasons: string[]
  nodes: number
}
export type CellResult = {
  index: number
  preview?: Preview
  text?: string
  offset?: number
  total?: number
}
export type CellsRequest = {
  revision: string
  indexes: number[]
  kind: "preview" | "text" | "source"
  offset?: number
}
export type CellsResponse = { revision: string; cells: CellResult[] }
