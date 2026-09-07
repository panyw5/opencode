import type { FileNode } from "@opencode-ai/sdk/v2"

type WatcherEvent = {
  type: string
  properties: unknown
}

type WatcherOps = {
  normalize: (input: string) => string
  hasFile: (path: string) => boolean
  isOpen?: (path: string) => boolean
  loadFile: (path: string) => void
  node: (path: string) => FileNode | undefined
  isDirLoaded: (path: string) => boolean
  refreshDir: (path: string) => void
}

export function invalidateFromWatcher(event: WatcherEvent, ops: WatcherOps) {
  if (event.type !== "file.watcher.updated") return
  const props =
    typeof event.properties === "object" && event.properties ? (event.properties as Record<string, unknown>) : undefined
  const rawPath = typeof props?.file === "string" ? props.file : undefined
  const kind = typeof props?.event === "string" ? props.event : undefined
  if (!rawPath) return
  if (!kind) return

  const path = ops.normalize(rawPath)
  if (!path) return
  if (path.startsWith(".git/")) return

  if (ops.hasFile(path) || ops.isOpen?.(path)) {
    ops.loadFile(path)
  }

  if (kind === "change") {
    const dir = (() => {
      if (path === "") return ""
      const node = ops.node(path)
      if (node?.type !== "directory") return
      return path
    })()
    if (dir === undefined) return
    if (!ops.isDirLoaded(dir)) return
    ops.refreshDir(dir)
    return
  }
  if (kind !== "add" && kind !== "unlink") return

  const parent = path.split("/").slice(0, -1).join("/")
  if (!ops.isDirLoaded(parent)) return

  ops.refreshDir(parent)
}

// A filesystem storm (git gc, checkout, build output) can deliver thousands of
// watcher events in a burst. Handling each one synchronously issues a fetch and
// a store update per event and freezes the UI. Collect the affected dirs/files
// for a short window and issue one deduplicated action per target instead.
const INVALIDATE_FLUSH_MS = 100

export function createWatcherInvalidator(ops: WatcherOps, flushMs = INVALIDATE_FLUSH_MS) {
  const dirs = new Set<string>()
  const files = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    timer = undefined
    if (dirs.size === 0 && files.size === 0) return
    const pendingDirs = Array.from(dirs)
    const pendingFiles = Array.from(files)
    dirs.clear()
    files.clear()
    for (const file of pendingFiles) ops.loadFile(file)
    for (const dir of pendingDirs) ops.refreshDir(dir)
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, flushMs)
  }

  return {
    handle(event: WatcherEvent) {
      invalidateFromWatcher(event, {
        ...ops,
        loadFile: (file) => {
          files.add(file)
          schedule()
        },
        refreshDir: (dir) => {
          dirs.add(dir)
          schedule()
        },
      })
    },
    flush,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = undefined
      dirs.clear()
      files.clear()
    },
  }
}
