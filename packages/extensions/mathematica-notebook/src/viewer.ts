import type { Output } from "./kernel"

// Keep the viewer independent from the full parser document (raw source and offsets).
// This matches notebook.read/save with view: true.
export type ViewerCell = {
  index: number
  style: string
  text: string
  editable: boolean
  runnable: boolean
  characters?: number
  deferred?: boolean
  // Index of the header cell of the enclosing CellGroupData, when grouped.
  parent?: number
  // This cell heads a group; folding it hides its descendants.
  group?: boolean
  // The group was serialized folded in the file (CellGroupData[..., Closed]).
  closed?: boolean
}
export type ViewerDocument = {
  path: string
  revision: string
  cells: ViewerCell[]
  outputs: Record<number, Output>
}
export type ViewerContent = Omit<ViewerDocument, "outputs">

export const LARGE_CELL_CHARACTERS = 100_000
export const PREVIEW_CHARACTERS = 600
export const VIRTUAL_BUFFER_PX = 400

export function isLargeText(value: string) {
  return value.length > LARGE_CELL_CHARACTERS
}

// Display only. Never use this result for editing, saving, or evaluation.
export function textPreview(value: string) {
  return value.length > PREVIEW_CHARACTERS ? `${value.slice(0, PREVIEW_CHARACTERS)}…` : value
}

export function viewerContent(next: ViewerDocument): ViewerContent {
  return {
    path: next.path,
    revision: next.revision,
    // Project fields explicitly, even if an older server ignores view: true.
    cells: next.cells.map(({ index, style, text, editable, runnable, characters, deferred, parent, group, closed }) => ({
      index,
      style,
      text,
      editable,
      runnable,
      ...(characters === undefined ? {} : { characters }),
      ...(deferred === undefined ? {} : { deferred }),
      ...(parent === undefined ? {} : { parent }),
      ...(group === undefined ? {} : { group }),
      ...(closed === undefined ? {} : { closed }),
    })),
  }
}

export function cellText(cell: ViewerCell, drafts: Record<number, string>) {
  return drafts[cell.index] ?? cell.text
}

export function draftEdits(drafts: Record<number, string>) {
  return Object.entries(drafts).map(([index, text]) => ({ index: Number(index), text }))
}

// Heading styles that may fold their group, ordered by outline rank. Styles
// not listed (Input, Output, Text, Item...) never fold.
const HEADING_RANK = new Map(
  ["Title", "Subtitle", "Chapter", "Subchapter", "Section", "Subsection", "Subsubsection"].map(
    (style, rank) => [style, rank] as const,
  ),
)
export function isFoldable(cell: ViewerCell) {
  return !!cell.group && HEADING_RANK.has(cell.style)
}

// Fallback for notebooks saved without CellGroupData: infer the outline from
// style ranks so headings can still fold. Only runs when the parser recorded
// no grouping at all.
export function applyOutline(cells: readonly ViewerCell[]): ViewerCell[] {
  if (cells.some((cell) => cell.group || cell.parent !== undefined)) return cells.slice()
  const stack: { index: number; rank: number }[] = []
  const outlined = cells.map((cell) => {
    const rank = HEADING_RANK.get(cell.style)
    if (rank !== undefined) while (stack.length && stack.at(-1)!.rank >= rank) stack.pop()
    const parent = stack.at(-1)?.index
    const next: ViewerCell = { ...cell, ...(parent === undefined ? {} : { parent }) }
    if (rank !== undefined) stack.push({ index: cell.index, rank })
    return next
  })
  // Only headings that actually head content get a fold control.
  const headings = new Set(outlined.filter((cell) => cell.parent !== undefined).map((cell) => cell.parent!))
  return outlined.map((cell) => (headings.has(cell.index) ? { ...cell, group: true } : cell))
}

// Group headers always precede their members, so a single pass suffices: a
// cell is hidden when its group header is folded or itself hidden.
export function visibleCells(cells: readonly ViewerCell[], folded: Record<number, boolean>): ViewerCell[] {
  if (!Object.values(folded).some(Boolean)) return cells.slice()
  const hidden = new Set<number>()
  const result: ViewerCell[] = []
  for (const cell of cells) {
    const hide = cell.parent !== undefined && (hidden.has(cell.parent) || !!folded[cell.parent])
    if (hide) {
      hidden.add(cell.index)
      continue
    }
    result.push(cell)
  }
  return result
}

export function pinnedCellPositions(cells: readonly ViewerCell[], focused?: number, composing?: number) {
  const indexes = new Set([focused, composing])
  indexes.delete(undefined)
  const positions: number[] = []
  for (let position = 0; position < cells.length && positions.length < indexes.size; position++) {
    if (indexes.has(cells[position].index)) positions.push(position)
  }
  return positions
}

export function listStartMargin(scroller: HTMLElement, anchor: HTMLElement) {
  return Math.max(
    0,
    anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientTop,
  )
}

// Reload cancellation is deliberately independent of the kernel/run controller.
export function createReloadGate() {
  let generation = 0
  let controller: AbortController | undefined
  const invalidate = () => {
    generation++
    controller?.abort()
    controller = undefined
  }
  return {
    invalidate,
    begin() {
      invalidate()
      const current = generation
      const request = new AbortController()
      controller = request
      return {
        signal: request.signal,
        current: () => current === generation && !request.signal.aborted,
        finish: () => {
          if (controller === request) controller = undefined
        },
      }
    },
  }
}

type ResizeEntry = {
  field: HTMLTextAreaElement
  syncScroll(): void
}
type ResizeScheduler = {
  request(callback: FrameRequestCallback): number
  cancel(id: number): void
}

// One frame for all visible editors: all writes, then all reads, then all writes.
export function createEditorResizeQueue(
  log: (message: string) => void,
  scheduler: ResizeScheduler = {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  },
) {
  const pending = new Map<HTMLTextAreaElement, ResizeEntry>()
  const heights = new WeakMap<HTMLTextAreaElement, number>()
  let frame: number | undefined
  let disposed = false
  const flush = () => {
    frame = undefined
    const entries = [...pending.values()].filter(({ field }) => field.isConnected)
    pending.clear()
    for (const { field } of entries) field.style.height = "auto"
    const sizes = entries.map(({ field }) => field.scrollHeight + 2)
    let changed = 0
    for (let index = 0; index < entries.length; index++) {
      const { field, syncScroll } = entries[index]
      const height = sizes[index]
      field.style.height = `${height}px`
      if (heights.get(field) !== height) changed++
      heights.set(field, height)
    }
    for (const { syncScroll } of entries) syncScroll()
    if (changed) log(`notebook editor layout cells=${entries.length} changed=${changed}`)
  }
  return {
    schedule(entry: ResizeEntry) {
      if (disposed) return
      pending.set(entry.field, entry)
      if (frame === undefined) frame = scheduler.request(flush)
    },
    remove(field: HTMLTextAreaElement) {
      pending.delete(field)
      heights.delete(field)
      if (!pending.size && frame !== undefined) {
        scheduler.cancel(frame)
        frame = undefined
      }
    },
    dispose() {
      disposed = true
      if (frame !== undefined) scheduler.cancel(frame)
      frame = undefined
      pending.clear()
    },
  }
}
export type EditorResizeQueue = ReturnType<typeof createEditorResizeQueue>
