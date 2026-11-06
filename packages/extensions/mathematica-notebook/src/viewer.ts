import type { Output } from "./kernel"

// Keep the viewer independent from the full parser document (raw source and offsets).
// This matches notebook.read/save with view: true.
export type ViewerCell = {
  index: number
  style: string
  text: string
  editable: boolean
  runnable: boolean
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
    cells: next.cells.map(({ index, style, text, editable, runnable }) => ({
      index,
      style,
      text,
      editable,
      runnable,
    })),
  }
}

export function cellText(cell: ViewerCell, drafts: Record<number, string>) {
  return drafts[cell.index] ?? cell.text
}

export function draftEdits(drafts: Record<number, string>) {
  return Object.entries(drafts).map(([index, text]) => ({ index: Number(index), text }))
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
    const sizes = entries.map(({ field }) => Math.min(600, field.scrollHeight + 2))
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
