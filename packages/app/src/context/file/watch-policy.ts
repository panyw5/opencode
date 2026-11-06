export type FileContentMode = "text" | "self"

type Counts = Record<FileContentMode, number>

// Leases belong to one registry generation. A delayed cleanup from an old
// directory/client must never decrement the same path in the new generation.
export function createFileWatchRegistry(changed: (file: string, count: number) => void) {
  const entries = new Map<string, Counts>()
  let epoch = 0
  return {
    mode(file: string): FileContentMode | undefined {
      const counts = entries.get(file)
      if (counts?.text) return "text"
      if (counts?.self) return "self"
    },
    acquire(file: string, mode: FileContentMode = "text") {
      const mark = epoch
      const counts = entries.get(file) ?? { text: 0, self: 0 }
      entries.set(file, counts)
      counts[mode]++
      changed(file, counts.text + counts.self)
      let released = false
      return () => {
        if (released) return
        released = true
        if (mark !== epoch || entries.get(file) !== counts) return
        counts[mode]--
        const count = counts.text + counts.self
        if (!count) entries.delete(file)
        changed(file, count)
      }
    },
    reset() {
      epoch++
      entries.clear()
    },
  }
}
