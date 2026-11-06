import type { FileContentMode } from "./watch-policy"

type Dependencies = {
  visible(): string[]
  stale(file: string): void
  load(file: string): Promise<void>
  content?(file: string): FileContentMode
  changed?(file: string): void
}

// All sources converge here; hidden cache entries become stale without doing I/O.
export function createFileRevalidation(deps: Dependencies, delay = 100) {
  const pending = new Set<string>()
  const dirty = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const revalidate = (file: string, content = deps.content?.(file) ?? "text") => {
    dirty.delete(file)
    deps.changed?.(file)
    if (content === "self") return Promise.resolve()
    return deps.load(file)
  }
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const visible = new Set(deps.visible())
    const files = [...pending].filter((file) => visible.has(file))
    pending.clear()
    for (const file of files) void revalidate(file)
  }
  const schedule = (file: string) => {
    pending.add(file)
    timer ??= setTimeout(flush, delay)
  }
  const invalidate = (file: string, reason: string) => {
    deps.stale(file)
    dirty.add(file)
    if (!deps.visible().includes(file)) return
    console.debug(`[file-preview] invalidate path=${file} reason=${reason}`)
    schedule(file)
  }
  return {
    invalidate,
    visible(reason: string) {
      for (const file of deps.visible()) invalidate(file, reason)
    },
    // A first watch is not itself a change. Only replay real invalidations
    // observed while hidden, including changes hidden between schedule/flush.
    resume() {
      for (const file of deps.visible()) {
        if (dirty.has(file)) schedule(file)
      }
    },
    refresh(file: string, content?: FileContentMode) {
      deps.stale(file)
      dirty.add(file)
      pending.delete(file)
      console.debug(`[file-preview] invalidate path=${file} reason=manual`)
      if ((content ?? deps.content?.(file)) === "self" && !deps.visible().includes(file)) return Promise.resolve()
      return revalidate(file, content)
    },
    flush,
    reset() {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending.clear()
      dirty.clear()
    },
  }
}
