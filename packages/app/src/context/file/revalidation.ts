type Dependencies = {
  visible(): string[]
  stale(file: string): void
  load(file: string): Promise<void>
}

// All sources converge here; hidden cache entries become stale without doing I/O.
export function createFileRevalidation(deps: Dependencies, delay = 100) {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const visible = new Set(deps.visible())
    const files = [...pending].filter((file) => visible.has(file))
    pending.clear()
    for (const file of files) void deps.load(file)
  }
  const invalidate = (file: string, reason: string) => {
    deps.stale(file)
    if (!deps.visible().includes(file)) return
    pending.add(file)
    console.debug(`[file-preview] invalidate path=${file} reason=${reason}`)
    timer ??= setTimeout(flush, delay)
  }
  return {
    invalidate,
    visible(reason: string) {
      for (const file of deps.visible()) invalidate(file, reason)
    },
    refresh(file: string) {
      deps.stale(file)
      pending.delete(file)
      console.debug(`[file-preview] invalidate path=${file} reason=manual`)
      return deps.load(file)
    },
    flush,
    reset() {
      if (timer) clearTimeout(timer)
      timer = undefined
      pending.clear()
    },
  }
}
