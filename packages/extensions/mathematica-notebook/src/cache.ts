import type { Notebook } from "./notebook"
import { viewerCells, type ViewerCell } from "./document"

export type CachedNotebook = { notebook: Notebook; view?: ViewerCell[]; bytes: number }

// Include source backing storage retained by sliced strings, cell strings, object
// overhead and a possible viewer DTO. These are estimates, not heap measurements.
export function notebookBytes(notebook: Notebook, sourceLength: number): number {
  return (
    sourceLength * 2 +
    128 +
    notebook.cells.reduce(
      (bytes, cell) => bytes + 320 + 2 * (cell.raw.length + cell.text.length + cell.style.length),
      0,
    )
  )
}

export function cachedViewerCells(entry: CachedNotebook): ViewerCell[] {
  return (entry.view ??= viewerCells(entry.notebook.cells))
}

/** Only result cells/offsets are retained. Parser ASTs and scan spans never enter this cache. */
export class NotebookCache {
  private entries = new Map<string, CachedNotebook>()
  private retainedBytes = 0

  constructor(
    readonly maxEntries = 8,
    readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  get size() {
    return this.entries.size
  }

  get bytes() {
    return this.retainedBytes
  }

  get(revision: string): CachedNotebook | undefined {
    const entry = this.entries.get(revision)
    if (!entry) return
    this.entries.delete(revision)
    this.entries.set(revision, entry)
    return entry
  }

  set(revision: string, entry: CachedNotebook): void {
    const previous = this.entries.get(revision)
    if (previous) {
      this.entries.delete(revision)
      this.retainedBytes -= previous.bytes
    }
    if (this.maxEntries < 1 || entry.bytes > this.maxBytes) return
    this.entries.set(revision, entry)
    this.retainedBytes += entry.bytes
    while (this.entries.size > this.maxEntries || this.retainedBytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value!
      this.entries.delete(oldest[0])
      this.retainedBytes -= oldest[1].bytes
    }
  }

  clear(): void {
    this.entries.clear()
    this.retainedBytes = 0
  }
}
